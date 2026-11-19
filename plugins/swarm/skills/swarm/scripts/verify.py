#!/usr/bin/env python3
"""Prepare, test and accept one candidate covering every worker in a Swarm run."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
from board import atomic_write, load, load_state, readiness, save


def git(path, *args, optional=False):
    try:
        # Git translates its messages; toplevel() reads one, so they are asked for untranslated.
        result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, env={**os.environ, "LC_ALL": "C"})
    except FileNotFoundError:
        if optional:
            return None
        raise ValueError("Git is required for isolated verification") from None
    if result.returncode == 0:
        return result.stdout
    if optional:
        return None
    raise ValueError(result.stderr.decode(errors="replace").strip() or "git failed")


def toplevel(project):
    """The repository root, or None outside a repository. Any other Git failure is an error, never 'no repository':
    a fallback there would fingerprint ignored files and call a broken checkout verified."""
    try:
        return git(project, "rev-parse", "--show-toplevel")
    except ValueError as error:
        if "not a git repository" in str(error) or "Git is required" in str(error):
            return None
        raise ValueError(f"git could not read {project}: {error}") from None


def repository(project):
    """The repository root and the project's own .swarm folder as Git names it from there, or None outside one."""
    top = toplevel(project)
    if top is None:
        return None
    root = Path(os.fsdecode(top.rstrip(b"\n"))).resolve()
    return root, os.fsencode((project.resolve() / ".swarm").relative_to(root).as_posix()).split(b"/")


def source_digest(project, nested=False):
    """Fingerprint the sources. The project's own .swarm folder holds run data and is left out; a folder of that
    name anywhere else, a nested repository's included, is the user's and counts as source."""
    found = repository(project)
    if found is None:
        root = project
        files = (os.fsencode(path.relative_to(root)) for path in root.rglob("*")
                 if ".git" not in (parts := path.relative_to(root).parts) and (nested or parts[0] != ".swarm")
                 and (path.is_symlink() or not path.is_dir()))
        head = b"non-git"
    else:
        root, run_data = found
        # Every tracked name with its "mode object stage"; a submodule's mode is 160000 and its object the recorded commit.
        tracked = {name: meta.split() for meta, _, name in (
            entry.partition(b"\t") for entry in git(root, "ls-files", "-z", "--stage").split(b"\0") if entry)}
        gitlinks = {name: meta[1] for name, meta in tracked.items() if meta[0] == b"160000"}
        # Run data is never source, whatever the project's .swarm/.gitignore says.
        files = (file for file in [*tracked, *git(root, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")]
                 if file and (nested or not is_run_data(file, run_data)))
        head = git(root, "rev-parse", "HEAD", optional=True) or b"unborn"
    digest = hashlib.sha256(head + b"\0")
    for name in sorted(set(files)):
        path = root / os.fsdecode(name)
        digest.update(len(name).to_bytes(8, "big") + name)
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            digest.update(b"missing\0")
            continue
        if stat.S_ISLNK(mode):
            content = hashlib.sha256(os.fsencode(os.readlink(path)))
            digest.update(b"link\0" + content.digest())
        elif stat.S_ISREG(mode):
            # A concurrent replacement with a pipe must never block the fingerprint.
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW), "rb") as f:
                before = os.fstat(f.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError(f"source changed while fingerprinting {path}")
                digest.update(b"x" if before.st_mode & stat.S_IXUSR else b"f")
                content = hashlib.sha256()
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    content.update(chunk)
                after = path.lstat()
                if any(getattr(before, key) != getattr(after, key) for key in (
                        "st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")):
                    raise ValueError(f"source changed while fingerprinting {path}")
                digest.update(content.digest())
        elif stat.S_ISDIR(mode) and found is not None and name in gitlinks and not ((path / ".git").exists() and (
                git(path, "rev-parse", "HEAD").strip() != gitlinks[name]
                or git(path, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"))):
            # A submodule's recorded commit stands for it, whether it is absent, as in a fresh worktree, or
            # checked out clean at that commit: the integration worktree and the user's checkout then agree.
            digest.update(b"gitlink\0" + gitlinks[name])
        elif stat.S_ISDIR(mode) and (path / ".git").exists():  # a nested repository, or a submodule that moved or is dirty
            digest.update(b"repo\0" + bytes.fromhex(source_digest(path, nested=True)))
        elif stat.S_ISDIR(mode) and found is not None and name in tracked:
            digest.update(b"dir\0")  # a tracked file replaced by a folder; the files in it are listed on their own
        else:
            raise ValueError(f"cannot fingerprint {path}")
    return digest.hexdigest()


@contextmanager
def board_lock(run):
    with (run / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@contextmanager
def verification_lock(directory):
    with (directory / ".verification.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("another verification action is already running in this checkout") from None
        yield


def inputs(run, mode):
    state, posts = load(run)
    if state.get("closed"):
        raise ValueError("the run is closed")
    members = state["members"]
    ready = readiness(members, posts)
    result = {}
    for name, member in members.items():
        # A consultant advises the coordinator: it contributes nothing to the candidate.
        if member.get("role") != "worker" or member.get("killed") or member.get("consult") == "1":
            continue
        if name not in ready:
            raise ValueError(f"waiting for READY from @{name}")
        post = ready[name]
        revision = post.get("revision")
        wants_commit = mode == "isolated" and member.get("writes") != "0"
        if wants_commit != bool(revision):
            raise ValueError(f"@{name} READY must {'include' if wants_commit else 'omit'} a commit")
        result[name] = [post["seq"], revision]
    if not result:
        raise ValueError("there are no active workers")
    return result


def save_candidate(run, candidate):
    atomic_write(run / "verification.json", json.dumps(candidate, indent=2))


def candidate_for(run, project, identifier):
    with (run / "verification.json").open(encoding="utf-8") as file:
        candidate = json.load(file)
    if not isinstance(candidate, dict):
        raise ValueError("verification.json is not a candidate; prepare a new one")
    if candidate["candidate"] != identifier or candidate["project"] != str(project):
        raise ValueError("that verification candidate has been superseded or belongs to another project")
    return candidate


def check_inputs(run, candidate):
    # An empty list passes only when `prepare --no-checks` asked for it: a candidate that lost its commands does not.
    deliberate = candidate.get("no_checks") is True and candidate["checks"] == []
    if not deliberate and (not isinstance(candidate["checks"], list) or not candidate["checks"] or any(not isinstance(check, str) or not check.strip() for check in candidate["checks"])):
        raise ValueError("the candidate is missing verification commands; prepare a new candidate")
    if candidate["inputs"] != inputs(run, candidate["mode"]):
        raise ValueError("worker readiness changed; prepare and test a new candidate")
    work = Path(candidate["path"])
    if candidate["mode"] == "isolated" and git(work, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
        raise ValueError("the integration checkout changed commit")
    if source_digest(work) != candidate["digest"]:
        raise ValueError("source files changed; prepare and test a new candidate")


def is_run_data(name, run_data):
    """A path, as Git names it from the repository root, that is the project's own .swarm folder or lies under it."""
    return name.rstrip(b"/").split(b"/")[:len(run_data)] == run_data


def pending_changes(project):
    """Paths git reports as changed or untracked, other than Swarm's own run data."""
    _, run_data = repository(project)
    entries = git(project, "status", "--porcelain", "-z", "--untracked-files=all").split(b"\0")
    pending, index = [], 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        paths = [entry[3:]]
        if any(letter in entry[:2] for letter in (b"R", b"C")):
            paths.append(entries[index])  # the other side of a rename can cross the .swarm boundary
            index += 1
        pending.extend(path for path in paths if not is_run_data(path, run_data))
    return pending


def check_current(run, candidate):
    """Raise unless a passing candidate still describes the reports and the sources it ran on."""
    if not candidate.get("accepted"):
        return check_inputs(run, candidate)
    # Accepted: its checkout may be gone, and the project itself now holds what was tested.
    project = Path(candidate["project"])
    if candidate["inputs"] != inputs(run, candidate["mode"]):
        raise ValueError("worker readiness changed after acceptance")
    if candidate["mode"] == "isolated" and git(project, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
        raise ValueError("the project moved off the accepted commit")
    if source_digest(project) != candidate["digest"]:
        raise ValueError("source files changed after acceptance")


def active_verifier(run, verifier):
    if not verifier:
        raise ValueError("no passing verification for this candidate")
    member = load_state(run)["members"].get(verifier, {})
    if member.get("role") != "verifier" or member.get("killed"):
        raise ValueError("an active verifier must run the checks")


def prepare(run, project, mode, checks):
    """CHECKS is None for a candidate with nothing a command could test, such as a designer's assets."""
    identifier = uuid.uuid4().hex[:16]
    with board_lock(run):
        recorded = inputs(run, mode)
        if checks is None:
            coders = sorted(name for name, member in load_state(run)["members"].items()
                            if name in recorded and member.get("writes") != "0" and member.get("profile") != "designer")
            if coders:
                raise ValueError("--no-checks is for a run whose only writers are designers; give --check commands that test the work of "
                                 + ", ".join("@" + name for name in coders))
    work = project
    integration = None
    base = commit = branch = None
    try:
        if mode == "isolated":
            base = git(project, "rev-parse", "HEAD").decode().strip()
            branch = git(project, "symbolic-ref", "-q", "HEAD", optional=True)
            root = Path(os.fsdecode(git(project, "rev-parse", "--show-toplevel").rstrip(b"\n")))
            integration = run / f"integration-{identifier}"
            git(project, "worktree", "add", "--detach", str(integration), base)
            for name, (_, revision) in recorded.items():
                if revision:
                    # The merge commit lands on the user's branch at acceptance, so it is made under the
                    # repository's own identity and signing settings, never under one of Swarm's.
                    try:
                        git(integration, "merge", "--no-autostash", "--no-edit", "--no-ff", revision)
                    except ValueError as error:
                        raise ValueError(f"could not merge @{name}'s commit {revision[:12]}: {error}. If Git asks for an identity "
                                         "or a signing key, configure it for this repository, then prepare again") from None
            commit = git(integration, "rev-parse", "HEAD").decode().strip()
            work = integration / project.relative_to(root)
            if not work.is_dir():
                raise ValueError("the requested project directory is missing in the candidate")
        candidate = {
            "candidate": identifier, "project": str(project), "path": str(work),
            "mode": mode, "base": base, "commit": commit, "checks": checks or [], "no_checks": checks is None,
            "branch": os.fsdecode(branch).strip() if branch else None,
            "worktree": str(integration) if integration else None,
            "inputs": recorded, "digest": source_digest(work),
        }
        with board_lock(run):
            check_inputs(run, candidate)
            try:
                with (run / "verification.json").open(encoding="utf-8") as file:
                    previous = json.load(file)
            except (OSError, ValueError):
                previous = None
            save_candidate(run, candidate)
    except BaseException:  # an interrupt too: a half-built integration worktree is never left behind
        if integration is not None and integration.exists():
            git(project, "worktree", "remove", "--force", str(integration), optional=True)
        raise
    # The candidate this one supersedes leaves its checkout behind. An accepted one is the record of what was
    # tested and stays, and nothing outside this run's folder is ever removed.
    stale = Path(previous.get("worktree") or "") if isinstance(previous, dict) and not previous.get("accepted") else None
    if stale and stale.parent == run and stale.name.startswith("integration-"):
        git(project, "worktree", "remove", "--force", str(stale), optional=True)
    print(json.dumps({"candidate": identifier, "path": str(work), "commit": commit,
                      "digest": candidate["digest"]}))


def test_candidate(run, project, identifier, verifier):
    attempt = uuid.uuid4().hex
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        active_verifier(run, verifier)
        if candidate.get("accepted"):
            raise ValueError("this candidate was accepted; prepare a new candidate to test again")
        check_inputs(run, candidate)  # before anything is cleared: a test that cannot run voids nothing
        candidate.pop("verified_by", None)
        candidate["attempt"] = attempt
        save_candidate(run, candidate)

    for command in candidate["checks"]:
        print(f"$ {command}", flush=True)
        result = subprocess.run(["/bin/sh", "-c", command], cwd=candidate["path"])
        print(f"Exit {result.returncode}", flush=True)
        if result.returncode:
            raise ValueError("verification failed")

    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate.get("attempt") != attempt:
            raise ValueError("another verification attempt superseded this one")
        active_verifier(run, verifier)
        check_inputs(run, candidate)
        candidate["verified_by"] = verifier
        save_candidate(run, candidate)
    print(f"VERIFIED {identifier} {candidate['commit'] or candidate['digest']}")


def accept(run, project, identifier):
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if not candidate.get("verified_by"):
            raise ValueError("no passing verification for this candidate")
        if candidate.get("accepted"):
            check_current(run, candidate)
            print(f"Already accepted {identifier}")
            return
        active_verifier(run, candidate["verified_by"])
        check_inputs(run, candidate)
        if candidate["mode"] == "isolated":
            if "branch" in candidate:
                branch = git(project, "symbolic-ref", "-q", "HEAD", optional=True)
                if (os.fsdecode(branch).strip() if branch else None) != candidate["branch"]:
                    raise ValueError("the user checkout switched branches; rebuild and reverify")
            head = git(project, "rev-parse", "HEAD").decode().strip()
            if head not in {candidate["base"], candidate["commit"]}:
                raise ValueError("the user checkout moved; rebuild and reverify")
            if pending_changes(project):
                raise ValueError("the user checkout has pending changes; keep the verified candidate and report the blocker")
            moved = head != candidate["commit"]
            if moved:
                git(project, "merge", "--ff-only", "--no-autostash", candidate["commit"])
            try:
                if git(project, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
                    raise ValueError("the checkout did not reach the verified commit")
                if source_digest(project) != candidate["digest"]:
                    raise ValueError("the checkout reached the commit but its files differ from the tested candidate")
            except (OSError, ValueError) as error:
                # A refused acceptance leaves the checkout where it found it; --keep never discards a local change.
                if moved and git(project, "reset", "--keep", head, optional=True) is None:
                    raise ValueError(f"{error}; the checkout could not be rolled back safely") from error
                raise
        candidate["accepted"] = True
        save_candidate(run, candidate)
        state, posts = load(run)
        state["accepted_seq"] = len(posts)  # the board counts failed verification cycles from here again
        save(run, state)
    print(f"ACCEPTED {identifier} {candidate['commit'] or candidate['digest']}")
    integration = candidate.get("worktree") or candidate["path"]
    if candidate["mode"] == "isolated" and git(project, "worktree", "remove", integration, optional=True) is None:
        print(f"Integration checkout retained at {integration}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("project", type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    prep = actions.add_parser("prepare")
    prep.add_argument("mode", choices=("shared", "isolated"))
    checks = prep.add_mutually_exclusive_group(required=True)
    checks.add_argument("--check", action="append")
    checks.add_argument("--no-checks", action="store_true")
    test = actions.add_parser("test")
    test.add_argument("candidate")
    test.add_argument("verifier")
    actions.add_parser("accept").add_argument("candidate")
    args = parser.parse_args()
    project = args.project.resolve(strict=True)
    run = args.run.resolve(strict=True)
    if run.parent != project / ".swarm" or not (run / "members.json").is_file():
        raise ValueError("expected an initialized Swarm run in the specified project")
    git_dir = git(project, "rev-parse", "--absolute-git-dir", optional=True)
    lock_directory = Path(os.fsdecode(git_dir.rstrip(b"\n"))) if git_dir else run.parent
    with verification_lock(lock_directory):
        if args.action == "prepare":
            if any(not check.strip() for check in args.check or []):
                raise ValueError("each verification check must be a nonempty command")
            prepare(run, project, args.mode, None if args.no_checks else args.check)
        elif args.action == "test":
            test_candidate(run, project, args.candidate, args.verifier)
        else:
            accept(run, project, args.candidate)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"verification: {error}")

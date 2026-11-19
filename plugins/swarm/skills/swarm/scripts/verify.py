#!/usr/bin/env python3
"""Prepare, test and accept one candidate covering every worker in a Swarm run."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
from board import REPORT_WORD, atomic_write, load, load_state, readiness, save

GIT_ENV_STRIP = {
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
}


def git(path, *args, optional=False):
    try:
        # Git translates its messages; toplevel() reads one, so they are asked for untranslated.
        env = {k: v for k, v in os.environ.items() if k not in GIT_ENV_STRIP}
        env["LC_ALL"] = "C"
        result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, env=env)
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


def _hash_entry(digest, path, mode):
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
    else:
        raise ValueError(f"cannot fingerprint {path}")


def _hash_dir(digest, root_dir):
    entries = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        for d in dirnames:
            p = Path(dirpath) / d
            if p.is_symlink():
                entries.append(p.relative_to(root_dir))
        for fn in filenames:
            entries.append((Path(dirpath) / fn).relative_to(root_dir))
    for rel in sorted(entries):
        name = os.fsencode(rel)
        digest.update(len(name).to_bytes(8, "big") + name)
        _hash_entry(digest, root_dir / rel, (root_dir / rel).lstat().st_mode)


def source_digest(project, nested=False, seen_roots=None):
    """Fingerprint the sources. The project's own .swarm folder holds run data and is left out; a folder of that
    name anywhere else, a nested repository's included, is the user's and counts as source."""
    if seen_roots is None:
        seen_roots = set()
    resolved_project = project.resolve()
    if resolved_project in seen_roots:
        raise ValueError(f"cyclic repository at {project}")
    seen_roots = seen_roots | {resolved_project}
    found = repository(project)
    if found is None:
        root = resolved_project
        found_files = []
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = Path(dirpath).relative_to(root)
            dirnames[:] = [
                d for d in dirnames
                if d != ".git" and (nested or rel_dir != Path(".") or d != ".swarm")
            ]
            for d in dirnames:
                p = Path(dirpath) / d
                if p.is_symlink():
                    found_files.append(os.fsencode(p.relative_to(root)))
            for fn in filenames:
                found_files.append(os.fsencode((Path(dirpath) / fn).relative_to(root)))
        files = found_files
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
        except (FileNotFoundError, NotADirectoryError):
            digest.update(b"missing\0")
            continue
        if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
            _hash_entry(digest, path, mode)
        elif stat.S_ISDIR(mode) and found is not None and name in gitlinks:
            sub_top = toplevel(path) if (path / ".git").exists() else None
            is_sub_repo = sub_top is not None and Path(os.fsdecode(sub_top.rstrip(b"\n"))).resolve() == path.resolve()
            if is_sub_repo:
                sub_head = git(path, "rev-parse", "HEAD", optional=True)
                if sub_head and sub_head.strip() == gitlinks[name] and not git(
                        path, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"):
                    # A submodule's recorded commit stands for it when checked out clean at that commit.
                    digest.update(b"gitlink\0" + gitlinks[name])
                else:
                    digest.update(b"repo\0" + bytes.fromhex(source_digest(path, nested=True, seen_roots=seen_roots)))
            elif not any(path.iterdir()):
                digest.update(b"gitlink\0" + gitlinks[name])
            else:
                digest.update(b"dir\0")
                _hash_dir(digest, path)
        elif stat.S_ISDIR(mode) and (path / ".git").exists():  # a nested repository, or a dir with a non-repo .git
            sub_top = toplevel(path)
            if sub_top is not None and Path(os.fsdecode(sub_top.rstrip(b"\n"))).resolve() == path.resolve() and path.resolve() not in seen_roots:
                digest.update(b"repo\0" + bytes.fromhex(source_digest(path, nested=True, seen_roots=seen_roots)))
            elif found is not None and name in tracked:
                digest.update(b"dir\0")
            else:
                digest.update(b"dir\0")
                _hash_dir(digest, path)
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


def check_no_checks(run, recorded):
    coders = sorted(name for name, member in load_state(run)["members"].items()
                    if name in recorded and member.get("writes") != "0" and member.get("profile") != "designer")
    if coders:
        raise ValueError("--no-checks is for a run whose only writers are designers; give --check commands that test the work of "
                         + ", ".join("@" + name for name in coders))


def check_checks_field(run, candidate, recorded):
    # An empty list passes only when `prepare --no-checks` asked for it: a candidate that lost its commands does not.
    deliberate = candidate.get("no_checks") is True and candidate.get("checks") == []
    if deliberate:
        check_no_checks(run, recorded)
    elif (not isinstance(candidate.get("checks"), list) or not candidate["checks"]
          or any(not isinstance(check, str) or not check.strip() for check in candidate["checks"])):
        raise ValueError("the candidate is missing verification commands; prepare a new candidate")


def check_inputs(run, candidate):
    recorded = inputs(run, candidate["mode"])
    check_checks_field(run, candidate, recorded)
    if candidate["inputs"] != recorded:
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
    found = repository(project)
    if found is None:
        raise ValueError("not a git repository")
    _, run_data = found
    entries = git(project, "status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none").split(b"\0")
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
    recorded = inputs(run, candidate["mode"])
    check_checks_field(run, candidate, recorded)
    if candidate["inputs"] != recorded:
        raise ValueError("worker readiness changed after acceptance")
    if candidate["mode"] == "isolated" and git(project, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
        raise ValueError("the project moved off the accepted commit")
    if source_digest(project) != candidate["digest"]:
        raise ValueError("source files changed after acceptance")


def active_verifier(run, verifier):
    verifier = verifier.lstrip("@").lower()
    if not verifier:
        raise ValueError("no passing verification for this candidate")
    member = load_state(run)["members"].get(verifier, {})
    if member.get("role") != "verifier" or member.get("killed"):
        raise ValueError("an active verifier must run the checks")


def prepare(run, project, mode, checks, onto=None):
    """CHECKS is None for a candidate with nothing a command could test, such as a designer's assets.
    ONTO names the commit an isolated candidate is built on when that is not the checkout's own HEAD."""
    identifier = uuid.uuid4().hex[:16]
    with board_lock(run):
        recorded = inputs(run, mode)
        if checks is None:
            check_no_checks(run, recorded)
    work = project
    integration = None
    base = commit = branch = None
    try:
        if mode == "isolated":
            base = git(project, "rev-parse", "--verify", (onto or "HEAD") + "^{commit}").decode().strip()
            branch = git(project, "symbolic-ref", "-q", "HEAD", optional=True)
            # A member that branched from somewhere else brings that history into the candidate with it: what is
            # tested is then neither the base nor the member's own branch. Said, not refused: it can be meant.
            astray = [name for name, (_, revision) in recorded.items() if revision
                      and git(project, "merge-base", "--is-ancestor", base, revision, optional=True) is None]
            if astray:
                print("note: %s did not branch from the candidate's base %s%s. If the members branched from another "
                      "ref, prepare again with --base <that ref>" % (", ".join("@" + name for name in astray), base[:12],
                                                                    "" if onto else " (the checkout's HEAD)"), file=sys.stderr)
            root = Path(os.fsdecode(git(project, "rev-parse", "--show-toplevel").rstrip(b"\n"))).resolve()
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
            diff = git(integration, "diff", "--no-renames", "--ignore-submodules=none", "--raw", "-z", base, commit).split(b"\0")
            for meta, name in zip(diff[::2], diff[1::2]):
                if b"160000" in meta.lstrip(b":").split()[:2]:
                    raise ValueError(f"cannot verify submodule update at {os.fsdecode(name)} in isolated mode; "
                                     "land submodule pointer changes by hand")
            work = integration / project.relative_to(root)
            if not work.is_dir():
                raise ValueError("the requested project directory is missing in the candidate")
        candidate = {
            "candidate": identifier, "project": str(project), "path": str(work),
            "mode": mode, "base": base, "onto": onto, "commit": commit, "checks": checks or [], "no_checks": checks is None,
            "branch": os.fsdecode(branch).strip() if branch else None,
            "worktree": str(integration) if integration else None,
            "inputs": recorded, "digest": source_digest(work),
        }
        with board_lock(run):
            current_inputs = inputs(run, mode)
            check_checks_field(run, candidate, current_inputs)
            if current_inputs != recorded:
                raise ValueError("worker readiness changed; prepare and test a new candidate")
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


def run_check(command, cwd, timeout):
    """One check in its own process group: whatever it started ends with it, on a timeout or an interruption too."""
    process = subprocess.Popen(["/bin/sh", "-c", command], cwd=cwd, stdin=subprocess.DEVNULL, start_new_session=True)

    def gone():
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except (ProcessLookupError, PermissionError):  # macOS answers EPERM for a group of exited processes
            return True
        return False

    def interrupted(number, _frame):
        raise SystemExit(128 + number)

    # The group no longer dies with this process, so a signal sent to it has to reach the cleanup below.
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGHUP)}
    try:
        return process.wait(timeout=timeout)
    except BaseException:
        # A check that ends on its own may leave what it started for the next check; one that is cut short may not.
        # A second signal must not cut the cleanup short: they are ignored until the group is gone.
        previous[signal.SIGINT] = signal.signal(signal.SIGINT, signal.SIG_IGN)
        for number in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(number, signal.SIG_IGN)
        for number in (signal.SIGTERM, signal.SIGKILL):
            if gone():
                break
            try:
                os.killpg(process.pid, number)
            except (ProcessLookupError, PermissionError):
                break
            deadline = time.monotonic() + 0.5
            while not gone() and time.monotonic() < deadline:
                time.sleep(0.02)
        process.wait()
        raise
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def test_candidate(run, project, identifier, verifier, timeout_arg=None):
    verifier = verifier.lstrip("@").lower()
    if timeout_arg is not None:
        raw_timeout = timeout_arg.strip()
        source_name = "--timeout"
        if not raw_timeout:
            raise ValueError("--timeout must be a positive number")
    else:
        raw_timeout = os.environ.get("SWARM_VERIFY_TIMEOUT", "").strip()
        source_name = "SWARM_VERIFY_TIMEOUT"
    if raw_timeout:
        try:
            timeout = float(raw_timeout)
        except ValueError:
            raise ValueError(f"{source_name} must be a positive number") from None
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError(f"{source_name} must be a positive number")
    else:
        timeout = None

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
        try:
            returncode = run_check(command, candidate["path"], timeout)
        except subprocess.TimeoutExpired:
            raise ValueError(f"verification command timed out after {timeout}s: {command}") from None
        print(f"Exit {returncode}", flush=True)
        if returncode:
            raise ValueError("verification failed")

    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate.get("attempt") != attempt:
            raise ValueError("the verification attempt was withdrawn or superseded")
        active_verifier(run, verifier)
        check_inputs(run, candidate)
        candidate["verified_by"] = verifier
        save_candidate(run, candidate)
    print(f"VERIFIED {identifier} {candidate['commit'] or candidate['digest']}")


def accept(run, project, identifier):
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if not candidate.get("verified_by"):
            raise ValueError("no passing verification for this candidate: a verifier's NOT PASSED or NOT VERIFIED "
                             "withdraws an earlier pass, so have the verifier run the test again")
        if candidate.get("accepted"):
            check_current(run, candidate)
            state, posts = load(run)
            if "accepted_seq" not in state:
                state["accepted_seq"] = len(posts)
                save(run, state)
            print(f"Already accepted {identifier}")
            return
        active_verifier(run, candidate["verified_by"])
        check_inputs(run, candidate)
        state, posts = load(run)
        verifier = candidate["verified_by"]
        expected_line = f"VERIFIED {identifier} {candidate.get('commit') or candidate.get('digest')}"
        latest_input_seq = max((seq for seq, _ in candidate["inputs"].values()), default=0)
        latest_rejection_seq = max(
            (
                p["seq"]
                for p in posts
                if state["members"].get(p["agent"], {}).get("role") == "verifier"
                and (word := REPORT_WORD.match(p["text"]))
                and word[1] in {"NOT PASSED", "NOT VERIFIED"}
            ),
            default=0,
        )
        cutoff_seq = max(latest_input_seq, latest_rejection_seq)
        if not any(
            p["seq"] > cutoff_seq
            and p["agent"] == verifier
            and (word := REPORT_WORD.match(p["text"])) and word[1] == "VERIFIED"  # `NOT VERIFIED <the line>` is no pass
            and re.search(rf"(?<!\w){re.escape(expected_line)}(?!\w)", p["text"].split("\n")[0])
            for p in posts
        ):
            raise ValueError(f"@{verifier} has not posted {expected_line} on the board")
        if candidate["mode"] == "isolated":
            # A candidate built on a named base is accepted from whatever branch sits on that base, not from the
            # branch the checkout happened to be on when it was prepared.
            if "branch" in candidate and not candidate.get("onto"):
                branch = git(project, "symbolic-ref", "-q", "HEAD", optional=True)
                if (os.fsdecode(branch).strip() if branch else None) != candidate["branch"]:
                    raise ValueError("the user checkout switched branches; rebuild and reverify")
            head = git(project, "rev-parse", "HEAD").decode().strip()
            if candidate.get("onto") and head not in {candidate["base"], candidate["commit"]}:
                raise ValueError("this candidate was built on %s, not on the checkout: deliver the verified commits from "
                                 "the members' branches, or check out that base and accept again" % candidate["onto"])
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
        state, posts = load(run)
        state["accepted_seq"] = len(posts)  # the board counts failed verification cycles from here again
        save(run, state)
        candidate["accepted"] = True
        save_candidate(run, candidate)
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
    prep.add_argument("--base", help="build an isolated candidate on this ref instead of the checkout's HEAD")
    test = actions.add_parser("test")
    test.add_argument("candidate")
    test.add_argument("verifier")
    test.add_argument("--timeout", help="per-check timeout in seconds (overrides SWARM_VERIFY_TIMEOUT)")
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
            if args.base and args.mode != "isolated":
                raise ValueError("--base is for an isolated candidate; a shared one is the checkout as it stands")
            prepare(run, project, args.mode, None if args.no_checks else args.check, args.base)
        elif args.action == "test":
            test_candidate(run, project, args.candidate, args.verifier, args.timeout)
        else:
            accept(run, project, args.candidate)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"verification: {error}")

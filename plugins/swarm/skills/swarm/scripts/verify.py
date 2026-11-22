#!/usr/bin/env python3
"""Prepare, test and accept one candidate covering every worker in a Swarm run, or test a partial one early."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
from board import REPORT_WORD, atomic_write, latest_reports, load, load_state, readiness, save, shown

GIT_ENV_STRIP = {
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
}


def clean_env():
    return {k: v for k, v in os.environ.items() if k not in GIT_ENV_STRIP}


def linked_worktrees(root):
    """Registered linked worktrees inside the repository, as paths Git names them from its root: they are other
    checkouts, not this one's source."""
    out = git(root, "worktree", "list", "--porcelain", optional=True) or b""
    top = Path(os.fsdecode(root)).resolve()
    inside = []
    for line in out.split(b"\n"):
        if line.startswith(b"worktree "):
            try:
                rel = Path(os.fsdecode(line[9:])).resolve().relative_to(top)
            except ValueError:
                continue
            if rel.parts:
                inside.append(os.fsencode(rel.as_posix()).split(b"/"))
    return inside


def not_source(found, run_data=None):
    """What the fingerprint leaves out, as paths Git names from the repository root: Swarm's run data (the project's
    .swarm folder, or RUN_DATA for a checkout whose top folder is not the run's project) and linked worktrees inside
    the repository. FOUND is what `repository` returns."""
    root, own = found
    return [run_data or own, *linked_worktrees(root)]


def stage_paths(skip):
    """The pathspecs that stage exactly what verification fingerprints, from any folder of the repository; SKIP is what
    `not_source` returns. A plain `git add -A` would also stage run data the project's ignore rules let through, and a
    linked worktree inside the repository as an embedded repository, neither of which any check read."""
    return [":/", *(":(top,literal,exclude)" + os.fsdecode(b"/".join(path)) for path in skip)]


def in_worktree(name, worktrees):
    parts = name.rstrip(b"/").split(b"/")
    return any(parts[:len(w)] == w for w in worktrees)


def git(path, *args, optional=False, index=None):
    try:
        # Git translates its messages; toplevel() reads one, so they are asked for untranslated.
        env = clean_env()
        env["LC_ALL"] = "C"
        if index:  # an index of the caller's own, the repository's left as it is
            env["GIT_INDEX_FILE"] = index
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


def trial_merge(project, base, revision, others):
    """The files merging REVISION with each of OTHERS ({peer: commit}) would conflict on, by peer, without touching any
    checkout. BASE, when given, is the merge base to use. Git before 2.38 has no `merge-tree --write-tree`: nothing then."""
    conflicts = {}
    for peer, other in others.items():
        command = ["git", "-C", str(project), "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z"]
        try:
            result = subprocess.run(command + (["--merge-base=" + base] if base else []) + [revision, other],
                                    capture_output=True, env=clean_env())
        except FileNotFoundError:
            return {}
        # Exit 1 is a conflict, or a commit Git does not know, which prints no file; anything else says nothing.
        files = [os.fsdecode(name) for name in result.stdout.split(b"\0")[1:] if name] if result.returncode == 1 else []
        if files:
            conflicts[peer] = files
    return conflicts


def toplevel(project):
    """The repository root, or None outside a repository. Any other Git failure is an error, never 'no repository':
    a fallback there would fingerprint ignored files and call a broken checkout verified."""
    try:
        return git(project, "rev-parse", "--show-toplevel")
    except ValueError as error:
        if "not a git repository" in str(error) or "Git is required" in str(error):
            return None
        raise ValueError(f"git could not read {project}: {error}") from None


def checked_out(path):
    """True when PATH is the top of a repository of its own, as a checked-out submodule is."""
    top = toplevel(path) if (path / ".git").exists() else None
    return top is not None and Path(os.fsdecode(top.rstrip(b"\n"))).resolve() == path.resolve()


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


def source_digest(project, nested=False, seen_roots=None, pointers=False):
    """Fingerprint the sources. The project's own .swarm folder holds run data and is left out; a folder of that
    name anywhere else, a nested repository's included, is the user's and counts as source.
    With POINTERS, as for an isolated candidate, a clean checked-out submodule stands for its commit, as an empty one
    does: the integration checkout never has it checked out, and the commit that lands records only the pointer.
    Without, the checks read the submodule's files in place, so a checked-out one is fingerprinted by its contents,
    which staging its pointer does not change, and one deinitialised after a pass no longer matches it."""
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
        root = found[0]
        # Every tracked name with its "mode object stage"; a submodule's mode is 160000 and its object the recorded commit.
        tracked = {name: meta.split() for meta, _, name in (
            entry.partition(b"\t") for entry in git(root, "ls-files", "-z", "--stage").split(b"\0") if entry)}
        gitlinks = {name: meta[1] for name, meta in tracked.items() if meta[0] == b"160000"}
        # Run data is never source, whatever the project's .swarm/.gitignore says; a nested repository's is the user's.
        skip = not_source(found)[1:] if nested else not_source(found)
        files = (file for file in [*tracked, *git(root, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")]
                 if file and not in_worktree(file, skip))
        head = git(root, "rev-parse", "HEAD", optional=True) or b"unborn"
    digest = hashlib.sha256(head + b"\0")
    for name in sorted(set(files)):
        path = root / os.fsdecode(name)
        try:
            mode = path.lstat().st_mode
        except (FileNotFoundError, NotADirectoryError):
            # A deleted file is absent whether or not the index still lists it: staging the deletion changes no source.
            continue
        if (stat.S_ISDIR(mode) and found is not None and name in tracked and name not in gitlinks
                and not (path / ".git").exists()):
            # A tracked file replaced by a folder: the files in it are listed on their own, as they are once staged.
            continue
        digest.update(len(name).to_bytes(8, "big") + name)
        if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
            _hash_entry(digest, path, mode)
        elif stat.S_ISDIR(mode) and found is not None and name in gitlinks:
            if checked_out(path):
                sub_head = git(path, "rev-parse", "HEAD", optional=True) if pointers else None
                if sub_head and not git(
                        path, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"):
                    # A clean submodule stands for its commit, the one staging records: the recorded one, or a new one
                    # whose pointer is staged or not yet, alike.
                    digest.update(b"gitlink\0" + sub_head.strip())
                else:
                    digest.update(b"repo\0" + bytes.fromhex(
                        source_digest(path, nested=True, seen_roots=seen_roots, pointers=pointers)))
            elif not any(path.iterdir()):
                digest.update(b"gitlink\0" + gitlinks[name])
            else:
                digest.update(b"dir\0")
                _hash_dir(digest, path)
        elif stat.S_ISDIR(mode) and (path / ".git").exists():  # a nested repository, or a dir with a non-repo .git
            sub_top = toplevel(path)
            if sub_top is not None and Path(os.fsdecode(sub_top.rstrip(b"\n"))).resolve() == path.resolve() and path.resolve() not in seen_roots:
                digest.update(b"repo\0" + bytes.fromhex(
                    source_digest(path, nested=True, seen_roots=seen_roots, pointers=pointers)))
            elif found is not None and name in tracked:
                digest.update(b"dir\0")
            else:
                digest.update(b"dir\0")
                _hash_dir(digest, path)
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


def inputs(run, mode, subset=None):
    """The READY post and commit of every contributing worker, or of the workers SUBSET names for a partial candidate."""
    state, posts = load(run)
    if state.get("closed"):
        raise ValueError("the run is closed")
    members = state["members"]
    ready = readiness(members, posts)
    # A consultant advises the coordinator: it contributes nothing to the candidate.
    workers = [name for name, member in members.items()
               if member.get("role") == "worker" and not member.get("killed") and member.get("consult") != "1"]
    stray = sorted(set(subset or ()) - set(workers))
    if stray:
        raise ValueError("--members takes the active workers a candidate holds, and not " + ", ".join("@" + n for n in stray))
    result = {}
    for name in workers:
        member = members[name]
        if subset is not None and name not in subset:
            continue
        if name not in ready:
            reported = latest_reports(posts).get(name, {}).get("kind") == "ready"
            raise ValueError(f"waiting for READY from @{name}" + (
                ": its last one no longer counts, because a NOT PASSED followed it or a member it depends on is not ready"
                if reported else ""))
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
    if candidate.get("candidate") != identifier or candidate.get("project") != str(project):
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


def subset_of(candidate):
    """The workers a partial candidate holds, or None for one that holds every worker."""
    return candidate["members"] if candidate.get("partial") else None


def check_inputs(run, candidate):
    recorded = inputs(run, candidate["mode"], subset_of(candidate))
    check_checks_field(run, candidate, recorded)
    if candidate["inputs"] != recorded:
        raise ValueError("worker readiness changed; prepare and test a new candidate")
    work = Path(candidate["path"])
    if candidate["mode"] == "isolated" and git(work, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
        raise ValueError("the integration checkout changed commit")
    if source_digest(work, pointers=candidate["mode"] == "isolated") != candidate["digest"]:
        raise ValueError("source files changed; prepare and test a new candidate")


def is_run_data(name, run_data):
    """A path, as Git names it from the repository root, that is the project's own .swarm folder or lies under it."""
    return name.rstrip(b"/").split(b"/")[:len(run_data)] == run_data


def pending_changes(project, run_data=None, codes=False):
    """Paths git reports as changed or untracked, other than Swarm's own run data: the project's .swarm folder, or
    RUN_DATA for a checkout whose top folder is not the run's project. With CODES, (XY, path) pairs of git's status."""
    found = repository(project)
    if found is None:
        raise ValueError("not a git repository")
    skip = not_source(found, run_data)
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
        pending.extend((entry[:2], path) if codes else path for path in paths
                       if not in_worktree(path, skip))
    return pending


def check_current(run, candidate):
    """Raise unless a passing candidate still describes the reports and the sources it ran on."""
    if not candidate.get("accepted"):
        return check_inputs(run, candidate)
    # Accepted: its checkout may be gone, and the project itself now holds what was tested.
    project = Path(candidate["project"])
    recorded = inputs(run, candidate["mode"], subset_of(candidate))
    check_checks_field(run, candidate, recorded)
    if candidate["inputs"] != recorded:
        raise ValueError("worker readiness changed after acceptance")
    if candidate["mode"] == "isolated" and git(project, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
        raise ValueError("the project moved off the accepted commit")
    if source_digest(project, pointers=candidate["mode"] == "isolated") != candidate["digest"]:
        raise ValueError("source files changed after acceptance")


def active_verifier(run, verifier):
    verifier = verifier.lstrip("@").lower()
    if not verifier:
        raise ValueError("no passing verification for this candidate")
    member = load_state(run)["members"].get(verifier, {})
    if member.get("role") != "verifier" or member.get("killed"):
        raise ValueError("an active verifier must run the checks")


def prepare(run, project, mode, checks, onto=None, subset=None):
    """CHECKS is None for a candidate with nothing a command could test, such as a designer's assets.
    ONTO names the commit an isolated candidate is built on when that is not the checkout's own HEAD.
    SUBSET names the workers of a partial candidate, which is tested and never accepted."""
    identifier = uuid.uuid4().hex[:16]
    with board_lock(run):
        recorded = inputs(run, mode, subset)
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
            _, run_data = repository(project)
            for meta, name in zip(diff[::2], diff[1::2]):
                # The fingerprint leaves the project's .swarm folder out, so a commit that writes there would be
                # merged into the board's own folder at acceptance without ever having been tested.
                if is_run_data(name, run_data):
                    raise ValueError("%s changes %s, which is Swarm's run data and no source. Its commit must leave the "
                                     "project's .swarm folder alone" % (
                                         ", ".join("@" + member for member, (_, revision) in recorded.items() if revision
                                                   and git(integration, "diff", "--no-renames", "--name-only", "-z", base, revision,
                                                           "--", ":(top,literal)" + os.fsdecode(name), optional=True))
                                         or "a member's commit", shown(name)))
                if b"160000" in meta.lstrip(b":").split()[:2]:
                    raise ValueError(f"cannot verify submodule update at {shown(name)} in isolated mode; "
                                     "land submodule pointer changes by hand")
            work = integration / project.relative_to(root)
            if not work.is_dir():
                raise ValueError("the requested project directory is missing in the candidate")
        candidate = {
            "candidate": identifier, "project": str(project), "path": str(work),
            "mode": mode, "base": base, "onto": onto, "commit": commit, "checks": checks or [], "no_checks": checks is None,
            "branch": os.fsdecode(branch).strip() if branch else None,
            "worktree": str(integration) if integration else None,
            "inputs": recorded, "digest": source_digest(work, pointers=mode == "isolated"),
            # Every file as prepared: the digest reads a clean submodule of an isolated checkout as its commit, so one
            # filled in afterwards, with files the landed commit will not bring, would go unseen.
            "exact": source_digest(work) if mode == "isolated" else None,
            "partial": subset is not None, "members": sorted(recorded),
        }
        with board_lock(run):
            current_inputs = inputs(run, mode, subset)
            check_checks_field(run, candidate, current_inputs)
            if current_inputs != recorded:
                raise ValueError("worker readiness changed; prepare and test a new candidate")
            try:
                with (run / "verification.json").open(encoding="utf-8") as file:
                    previous = json.load(file)
            except (OSError, ValueError):
                previous = None
            # The candidates this one replaces, with the reports each held: a verdict on one of them that arrives
            # late is the board's to tell from a verdict on this one.
            if isinstance(previous, dict) and isinstance(previous.get("candidate"), str):
                earlier = previous.get("superseded") if isinstance(previous.get("superseded"), list) else []
                candidate["superseded"] = [*earlier, {"candidate": previous["candidate"], "inputs": previous.get("inputs")}]
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
                      "digest": candidate["digest"], "partial": candidate["partial"]}))


def run_check(command, cwd, timeout, output=None):
    """One check in its own process group: whatever it started ends with it, on a timeout or an interruption too.
    OUTPUT, an open file, takes its stdout and stderr together; the check writes to it directly, so nothing is held
    in memory and what it printed before it was killed is there too."""
    def interrupted(number, _frame):
        raise SystemExit(128 + number)

    # The group no longer dies with this process, so a signal sent to it has to reach the cleanup below,
    # and the handlers are in place before the check can start.
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGHUP)}
    previous[signal.SIGINT] = signal.getsignal(signal.SIGINT)  # cleanup ignores it; the finally restores it
    process = None
    try:
        process = subprocess.Popen(["/bin/sh", "-c", command], cwd=cwd, stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=None if output is None else subprocess.STDOUT,
                                   env=clean_env(), start_new_session=True)
        returncode = process.wait(timeout=timeout)
        cleanup(process)  # what it left in the background ends with it too
        return returncode
    except BaseException:
        if process is not None:
            cleanup(process)
        raise
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def descendant_groups(pid):
    """Process groups of everything below pid, found from one ps snapshot."""
    try:
        listed = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid="], capture_output=True, text=True)
    except OSError:
        return set()
    if listed.returncode != 0:
        return set()
    rows = [tuple(map(int, fields)) for fields in map(str.split, listed.stdout.splitlines())
            if len(fields) == 3 and all(field.isdigit() for field in fields)]
    below, grew = {pid}, True
    while grew:
        grew = False
        for child, parent, _ in rows:
            if parent in below and child not in below:
                below.add(child)
                grew = True
    # Group 0 is the caller's own to killpg, and group 1 is init's.
    return {group for child, _, group in rows if child in below and group > 1} - {os.getpgrp()}


def cleanup(process):
    # ponytail: descendants that left the group are found by a snapshot taken now; one already orphaned
    # to init, or started after the snapshot, is not reached.
    # A second signal must not cut the cleanup short, the snapshot below included: they are ignored until the
    # groups are gone. The caller's finally restores the previous handlers.
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, signal.SIG_IGN)
    groups = {process.pid} | descendant_groups(process.pid)

    def gone(group):
        if group == process.pid:
            process.poll()
        try:
            os.killpg(group, 0)
        except (ProcessLookupError, PermissionError):  # macOS answers EPERM for a group of exited processes
            return True
        return False

    for number in (signal.SIGTERM, signal.SIGKILL):
        for group in groups:
            if not gone(group):
                try:
                    os.killpg(group, number)
                except (ProcessLookupError, PermissionError):
                    pass
        deadline = time.monotonic() + 0.5
        while not all(gone(g) for g in groups) and time.monotonic() < deadline:
            time.sleep(0.02)
    process.wait()


# What the verifier sees of a check's output; the log holds all of it. Everything printed stays in its conversation
# and is read again on every later step. A short pass is shown whole; a longer one only its summary line ("Ran 115
# tests ... OK") and a few before it; a failure enough of a traceback or a compiler error to act on, however long
# its lines are.
WHOLE_LINES, WHOLE_BYTES = 20, 1000
PASS_LINES, PASS_BYTES = 5, 600
FAIL_LINES, FAIL_BYTES = 60, 4000


def lines_in(log):
    count, last = 0, b"\n"
    with log.open("rb") as file:
        while chunk := file.read(1 << 20):  # a long log is counted a piece at a time, never held whole
            count += chunk.count(b"\n")
            last = chunk[-1:]
    return count + (last != b"\n")


def excerpt(log, count, lines, limit):
    """(lines kept, text): the last LINES lines of LOG, which holds COUNT, at most LIMIT bytes. Whole lines are
    kept where any fit; a single longer line is cut on a character boundary."""
    with log.open("rb") as file:
        start = max(0, file.seek(0, os.SEEK_END) - limit)
        file.seek(start)
        window = file.read().removesuffix(b"\n").split(b"\n") if count else []
    kept = window[-lines:]
    if start and len(kept) == len(window):  # its first line began before the window
        if len(kept) > 1:
            kept = kept[1:]
        else:
            kept[0] = kept[0].lstrip(bytes(range(0x80, 0xC0)))  # no half of a UTF-8 character
    return len(kept), b"\n".join(kept).decode(errors="replace")


def log_name(identifier, number, index):
    return f"{identifier}-attempt{number:02d}-check{index:02d}.log"


def reserve(logs, identifier):
    """The next attempt's number, taken by creating its first log exclusively: two tests that counted the same
    logs at once still never write into one file."""
    number = 1 + max((int(log.name.split("-")[1][len("attempt"):])
                      for log in logs.glob(f"{identifier}-attempt*-check*.log")), default=0)
    while True:
        try:
            (logs / log_name(identifier, number, 1)).open("xb").close()
            return number
        except FileExistsError:
            number += 1


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
        # Every file as it is while the checks run: the candidate's own digest reads a clean submodule of an isolated
        # checkout as its commit, so checks that filled one in, with files the landed commit will not bring, went unseen.
        exact = candidate.get("exact") or (source_digest(Path(candidate["path"])) if candidate["mode"] == "isolated" else None)
        if exact is not None and source_digest(Path(candidate["path"])) != exact:
            raise ValueError("the candidate's checkout changed since it was prepared (a submodule filled in or emptied?); "
                             "prepare and test a new candidate")
        # The candidate this verifier is testing, until it posts a verdict on it: a verdict that names none answers
        # this one, even once another candidate has replaced it.
        state = load_state(run)
        state["members"][verifier]["tested"] = identifier
        save(run, state)

    # Under the run folder, so inside the project's .swarm folder: never in the candidate's checkout, where the
    # fingerprint would read them, and never staged by `commit`. An earlier attempt's logs stay.
    logs = run / "checks"
    logs.mkdir(exist_ok=True)
    number = reserve(logs, identifier) if candidate["checks"] else None
    failed = []
    for index, command in enumerate(candidate["checks"], 1):
        print(f"$ {command}", flush=True)
        log = logs / log_name(identifier, number, index)
        started = time.monotonic()
        try:
            with log.open("wb") as output:
                returncode = run_check(command, candidate["path"], timeout, output)
        except subprocess.TimeoutExpired:
            returncode = None
        elapsed, size, count = time.monotonic() - started, log.stat().st_size, lines_in(log)
        shown, tail = excerpt(log, count, *(
            (FAIL_LINES, FAIL_BYTES) if returncode != 0 else
            (WHOLE_LINES, WHOLE_BYTES) if count <= WHOLE_LINES and size <= WHOLE_BYTES else (PASS_LINES, PASS_BYTES)))
        print("%s in %.1fs, %d lines (%d bytes) of output, log: %s" % (
            f"Timed out after {timeout}s" if returncode is None else f"Exit {returncode}", elapsed, count, size, log),
            flush=True)
        if tail:
            # As bytes: the output may hold what the terminal's encoding cannot.
            sys.stdout.buffer.write(tail.encode() + b"\n")
            sys.stdout.buffer.flush()
        if returncode != 0:
            print(f"(the last {shown} of {count} lines; Grep the log for the rest, then Read the lines you need: {log})",
                  flush=True)
        if returncode is None:
            raise ValueError(f"verification command timed out after {timeout}s: {command}")
        if returncode:
            failed.append(command)
    if failed:
        # Every check ran: a cycle that stops at the first failure hides the rest until the next candidate.
        raise ValueError("verification failed: " + "; ".join(failed))

    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate.get("attempt") != attempt:
            raise ValueError("the verification attempt was withdrawn or superseded")
        active_verifier(run, verifier)
        check_inputs(run, candidate)
        if exact is not None and source_digest(Path(candidate["path"])) != exact:
            raise ValueError("the checks changed files in the candidate's checkout (a submodule they filled in or emptied?), "
                             "so what they read is not what the commit holds; prepare and test a new candidate")
        candidate["verified_by"] = verifier
        save_candidate(run, candidate)
    print(f"VERIFIED {identifier} {candidate['commit'] or candidate['digest']}")


def stray_submodules(root):
    """The submodules under ROOT, at any depth, that are not checked out and yet hold files, as paths from ROOT."""
    strays = []
    for meta, _, name in (entry.partition(b"\t") for entry in git(root, "ls-files", "-z", "--stage").split(b"\0")):
        if meta.startswith(b"160000 "):
            path = root / os.fsdecode(name)
            if checked_out(path):
                strays += [os.fsdecode(name) + "/" + inner for inner in stray_submodules(path)]
            elif path.is_dir() and any(path.iterdir()):
                strays.append(os.fsdecode(name))
    return strays


def landing_guards(project, found):
    """Raises while the index or the checkout holds something the one commit after a shared `accept` would take unread
    or leave out. What is merely staged apart from the verified files is no matter: `commit` stages them anew. FOUND is
    what `repository` returns."""
    # The one commit after a shared acceptance takes the index. Run data or a linked worktree staged already
    # would go into it unread: the fingerprint, and so the status read below, leave both out.
    skip = not_source(found)
    # Without --no-renames a staged rename out of run data names only its new path.
    staged = [os.fsdecode(name) for name in git(found[0], "diff", "--cached", "--name-only", "--no-renames", "-z")
              .split(b"\0") if name and in_worktree(name, skip)]
    if staged:
        raise ValueError("the Git index holds %s, which is Swarm's run data or a linked worktree and no source, and the "
                         "commit after `accept` takes the index. Run `git reset -q -- %s` to unstage it (no file "
                         "changes), accept again, then commit with the command `accept` prints"
                         % (", ".join(map(shown, staged[:5])) + (" and more" if len(staged) > 5 else ""),
                            " ".join(shlex.quote(":(top,literal)" + name) for name in staged)))
    # `git add` here cannot stage what changed inside a submodule, so the commit would leave out bytes the
    # checks read; the fingerprint holds them, so nothing else catches this.
    pointers = {os.fsdecode(name): meta.split()[1].decode() for meta, _, name in (
        entry.partition(b"\t") for entry in git(found[0], "ls-files", "-z", "--stage").split(b"\0"))
        if meta.startswith(b"160000 ")}
    submodules = list(pointers)
    # A pointer no .gitmodules entry backs is one nobody else can resolve: refused once the commit would record
    # or move it, staged already or not.
    registered = {entry.partition(b"\n")[2] for entry in (git(
        found[0], "config", "-z", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$", optional=True) or b"").split(b"\0")}
    # The commit holds .gitmodules as staging takes it: untracked and ignored, it stays out, and registers nothing there.
    if (git(found[0], "ls-files", "--error-unmatch", "--", ":(top,literal).gitmodules", optional=True) is None
            and git(found[0], "check-ignore", "-q", "--", ".gitmodules", optional=True) is not None):
        registered = set()
    loose = [name for name in submodules if os.fsencode(name) not in registered and git(
        found[0], "status", "--porcelain", "--ignore-submodules=none", "--", ":(top,literal)" + name)]
    if loose:
        raise ValueError("%s is a Git repository of its own that no .gitmodules entry names, so the commit after "
                         "`accept` would record a pointer to it and none of its files. Add it as a submodule, or "
                         "unstage it (`git reset -q -- <path>`, or `git rm --cached <path>` once it is committed) and "
                         "ignore it or move it out, then prepare and test a new candidate" % ", ".join(map(shown, loose)))
    dirty = [name for name in submodules if checked_out(found[0] / name) and git(
        found[0] / name, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none")]
    if dirty:
        raise ValueError("the submodule %s holds changes of its own, which `git add` in this repository cannot "
                         "stage, so the commit after `accept` would leave them out. Commit them inside the "
                         "submodule, then prepare and test a new candidate" % ", ".join(map(shown, dirty)))
    # Not checked out, a submodule's folder holds nothing of it: files put there are read by the checks and held
    # by the fingerprint, and `git add` stages none of them. Inside a checked-out submodule no status shows them.
    strays = stray_submodules(found[0])
    if strays:
        raise ValueError("the submodule %s is not checked out, yet files sit in its folder, which the checks read and "
                         "the commit after `accept` cannot hold. Move them out, or check the submodule out (`git "
                         "submodule update --init --recursive`), then prepare and test a new candidate" % ", ".join(map(shown, strays)))
    # `git add -A` leaves the new commit of a submodule whose .gitmodules entry says ignore = all unstaged, so
    # the commit would keep the old pointer while the checks ran on the new one.
    unstaged = [name for name in submodules if checked_out(found[0] / name)
                and (git(found[0] / name, "rev-parse", "HEAD", optional=True) or b"").decode().strip() not in ("", pointers[name])
                and not git(found[0], "add", "-A", "--dry-run", "--", ":(top,literal)" + name, optional=True)]
    if unstaged:
        raise ValueError("the submodule %s is at a new commit that `git add -A` leaves unstaged (its .gitmodules entry "
                         "says ignore = all), so the commit after `accept` would keep the old pointer. Run `git add -f "
                         "-- %s` to stage it (no file changes), accept again, then commit with the command `accept` prints"
                         % (", ".join(map(shown, unstaged)), " ".join(shlex.quote(":(top,literal)" + name) for name in unstaged)))
    # Git lists an untracked repository of its own as one name with a slash, and `git add` records it as a pointer
    # to its commit that nothing can resolve, with none of the files the checks read.
    nested = [os.fsdecode(name) for name in git(found[0], "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")
              if name.endswith(b"/") and not in_worktree(name, skip)]
    if nested:
        raise ValueError("%s is a Git repository of its own inside this one and no submodule, so the commit after "
                         "`accept` would record a pointer to it and none of its files. Add it as a submodule, ignore "
                         "it or move it out, then prepare and test a new candidate" % ", ".join(map(shown, nested)))


def landing(run, project, identifier):
    """The command that makes the one commit after a shared acceptance."""
    return "Commit with: python3 %s %s %s commit %s -m '<message>'" % (
        shlex.quote(os.path.abspath(__file__)), shlex.quote(str(run)), shlex.quote(str(project)), identifier)


def commit(run, project, identifier, message):
    """The one commit after a shared acceptance, made of exactly what passed: staged here, compared with the pass, and
    committed, so nothing edited between a printed `git add` and the commit can go in unread."""
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate["mode"] == "isolated":
            raise ValueError("an isolated candidate's commits are in the checkout once it is accepted: there is nothing to commit")
        if not candidate.get("accepted"):
            raise ValueError("this candidate is not accepted: run `accept` first")
        found = repository(project)
        if found is None:
            raise ValueError("the project is not a Git repository, so there is nothing to commit")
        check_current(run, candidate)
        landing_guards(project, found)
        # Built in an index of its own and checked there, then put in the repository's: whatever was staged before,
        # the commit takes this tree and no other.
        skip = not_source(found)
        live = git(found[0], "rev-parse", "--path-format=absolute", "--git-path", "index").decode().strip()
        with tempfile.TemporaryDirectory() as scratch:
            private = os.path.join(scratch, "index")
            if os.path.exists(live):
                shutil.copy2(live, private)
            git(found[0], "add", "-A", "--", *stage_paths(skip), index=private)
            tree = git(found[0], "write-tree", index=private).decode().strip()
            names = [name for name in git(found[0], "diff", "--cached", "--name-only", "--no-renames", "-z", index=private)
                     .split(b"\0") if name]
            modes = dict((entry.partition(b"\t")[2], entry.split()[0]) for entry in
                         git(found[0], "ls-files", "-s", "-z", index=private).split(b"\0") if entry)
        unread = [shown(os.fsdecode(name)) for name in names if in_worktree(name, skip)]
        if unread:
            raise ValueError("the commit would hold %s, which is Swarm's run data or a linked worktree and no source"
                             % ", ".join(unread[:5]))
        # What Git stores is the file as its filters and line-ending rules convert it: a file a fresh checkout would
        # not bring back as the checks read it was never tested in the form the commit holds.
        turned = []
        for name in names:
            if modes.get(name) not in (b"100644", b"100755"):
                continue
            back = git(found[0], "cat-file", "--filters", "%s:%s" % (tree, os.fsdecode(name)), optional=True)
            try:
                same = back is not None and (found[0] / os.fsdecode(name)).read_bytes() == back
            except OSError:
                same = False
            if not same:
                turned.append(shown(os.fsdecode(name)))
        if turned:
            raise ValueError("a fresh checkout of the commit would not bring back %s as the checks read it (a line-ending "
                             "or filter rule converts it one way only). Fix the file or its .gitattributes rule, then "
                             "prepare and test a new candidate" % ", ".join(turned[:5]))
        git(found[0], "read-tree", tree)
        left = [shown(os.fsdecode(path)) for code, path in pending_changes(project, codes=True) if code[1:] != b" "]
        if left:
            raise ValueError("staging left %s apart from the index, so the commit would not hold the verified files; "
                             "prepare and test a new candidate" % ", ".join(left[:5]))
        if source_digest(project) != candidate["digest"]:
            raise ValueError("source files changed after acceptance")
        if tree == (git(found[0], "rev-parse", "-q", "--verify", "HEAD^{tree}", optional=True) or b"").decode().strip():
            print("Nothing to commit: HEAD already holds the verified files")
            return
    # Outside the board's lock: a commit hook may build and test for minutes.
    out = git(found[0], "commit", "-m", message)
    sys.stdout.write(os.fsdecode(out))
    if git(found[0], "rev-parse", "HEAD^{tree}").decode().strip() != tree:
        raise ValueError("the commit was made, but its files differ from the verified ones: a commit hook changed them, "
                         "or the index changed while it ran. Inspect it with `git show --stat HEAD`")
    print("COMMITTED %s %s" % (identifier, git(found[0], "rev-parse", "HEAD").decode().strip()))


def accept(run, project, identifier):
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate.get("partial"):
            raise ValueError("candidate %s holds only %s: a partial candidate tests pieces early and is never accepted. "
                             "Prepare one without --members once every worker is ready"
                             % (identifier, ", ".join("@" + name for name in candidate["members"])))
        if not candidate.get("verified_by"):
            raise ValueError("no passing verification for this candidate: a verifier's NOT PASSED or NOT VERIFIED "
                             "withdraws an earlier pass, so have the verifier run the test again")
        if candidate.get("accepted"):
            check_current(run, candidate)
            state, posts = load(run)
            if "accepted_seq" not in state:
                state["accepted_seq"] = len(posts)
                save(run, state)
            # The index may have changed since the first acceptance, and the fingerprint leaves run data out: the
            # commit this retry prints the command for is guarded as the first one was.
            found = repository(project) if candidate["mode"] != "isolated" else None
            if found is not None:
                landing_guards(project, found)
            print(f"Already accepted {identifier}")
            if found is not None:
                print(landing(run, project, identifier))
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
                and p.get("candidate") in (None, identifier)  # a late verdict on a candidate this one replaced
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
        guidance = None
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
                # By default a fast-forward overwrites an ignored file in the way of the new commit, a parent
                # folder's name included; refused, git names each one and the checkout stays as it was.
                try:
                    git(project, "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", candidate["commit"])
                except ValueError as error:
                    raise ValueError(f"{error}\nmove them aside and accept again") from None
            try:
                if git(project, "rev-parse", "HEAD").decode().strip() != candidate["commit"]:
                    raise ValueError("the checkout did not reach the verified commit")
                if source_digest(project, pointers=True) != candidate["digest"]:
                    raise ValueError("the checkout reached the commit but its files differ from the tested candidate")
            except BaseException as error:  # an interrupt too
                # A refused acceptance leaves the checkout where it found it; --keep never discards a local change.
                if moved and git(project, "reset", "--keep", head, optional=True) is None:
                    raise ValueError(f"{error or type(error).__name__}; the checkout could not be rolled back safely") from error
                raise
        elif (found := repository(project)) is not None:
            # Built before the candidate is saved as accepted: a retry after that takes the "already accepted" path.
            landing_guards(project, found)
            guidance = landing(run, project, identifier)
        state, posts = load(run)
        state["accepted_seq"] = len(posts)  # the board counts failed verification cycles from here again
        save(run, state)
        candidate["accepted"] = True
        save_candidate(run, candidate)
    print(f"ACCEPTED {identifier} {candidate['commit'] or candidate['digest']}")
    if guidance:
        print(guidance)
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
    prep.add_argument("--members", help="a partial candidate of these workers, comma-separated: tested, never accepted")
    test = actions.add_parser("test")
    test.add_argument("candidate")
    test.add_argument("verifier")
    test.add_argument("--timeout", help="per-check timeout in seconds (overrides SWARM_VERIFY_TIMEOUT)")
    actions.add_parser("accept").add_argument("candidate")
    landed = actions.add_parser("commit")
    landed.add_argument("candidate")
    landed.add_argument("-m", "--message", required=True)
    args = parser.parse_args()
    project = args.project.resolve(strict=True)
    run = args.run.resolve(strict=True)
    if run.parent != (project / ".swarm").resolve() or not (run / "members.json").is_file():
        raise ValueError("expected an initialized Swarm run in the specified project")
    git_dir = git(project, "rev-parse", "--absolute-git-dir", optional=True)
    lock_directory = Path(os.fsdecode(git_dir.rstrip(b"\n"))) if git_dir else run.parent
    with verification_lock(lock_directory):
        if args.action == "prepare":
            if any(not check.strip() for check in args.check or []):
                raise ValueError("each verification check must be a nonempty command")
            if args.base is not None and args.mode != "isolated":
                raise ValueError("--base is for an isolated candidate; a shared one is the checkout as it stands")
            if args.base is not None and (not args.base.strip() or args.base.startswith("-")):
                # One starting with "-" would reach `git rev-parse` as an option.
                raise ValueError("--base takes a ref, such as a branch name or a commit")
            subset = None
            if args.members is not None and args.mode != "isolated":
                # A shared candidate is the whole checkout, edits of the other workers included: no part of it stands alone.
                raise ValueError("--members is for an isolated candidate; a shared one always holds every worker's edits")
            if args.members is not None:
                subset = list(dict.fromkeys(n.strip().lstrip("@").lower() for n in args.members.split(",") if n.strip()))
                if not subset:
                    raise ValueError("--members takes worker names, separated by commas")
            prepare(run, project, args.mode, None if args.no_checks else args.check, args.base, subset)
        elif args.action == "test":
            test_candidate(run, project, args.candidate, args.verifier, args.timeout)
        elif args.action == "commit":
            if not args.message.strip():
                raise ValueError("the commit needs a message")
            commit(run, project, args.candidate, args.message)
        else:
            accept(run, project, args.candidate)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"verification: {error}")

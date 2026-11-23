#!/usr/bin/env python3
"""Prepare, test and accept one candidate covering every worker in a Swarm run, or test a partial one early."""
import argparse
from contextlib import contextmanager
import errno
import fcntl
import filecmp
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
from board import REPORT_WORD, atomic_write, latest_reports, load, load_state, readiness, save, shown, unfenced, withdrawn_in

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


def git(path, *args, optional=False, index=None, data=None):
    try:
        # Git translates its messages; toplevel() reads one, so they are asked for untranslated.
        env = clean_env()
        env["LC_ALL"] = "C"
        if index:  # an index of the caller's own, the repository's left as it is
            env["GIT_INDEX_FILE"] = index
        result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, env=env, input=data)
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


def inputs(run, mode, subset=None, *, allow_closed=False):
    """The READY post and commit of every contributing worker, or of the workers SUBSET names for a partial candidate."""
    state, posts = load(run)
    if state.get("closed") and not allow_closed:
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


def pending_changes(project, run_data=None, codes=False, *, git_index=None):
    """Paths git reports as changed or untracked, other than Swarm's own run data: the project's .swarm folder, or
    RUN_DATA for a checkout whose top folder is not the run's project. With CODES, (XY, path) pairs of git's status."""
    found = repository(project)
    if found is None:
        raise ValueError("not a git repository")
    skip = not_source(found, run_data)
    entries = git(project, "--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all",
                  "--ignore-submodules=none", index=git_index).split(b"\0")
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


# Diff hygiene: mechanical checks on what a candidate changes, made at `prepare` so that a candidate with one of these
# defects never costs a verifier's review. Ported from OpenSwarm (MIT, Copyright (c) 2026 Heewon Oh): rewriteGuard.ts,
# reformatMix.ts and callerCheckGuard.ts. Where upstream repairs a file or reads the worker's summary, this reads the
# READY reports and only refuses: nothing here edits a source.
REWRITE_MIN_LINES = 20  # a shorter file may be rewritten freely: rewriting 15 lines is an edit
REWRITE_MAX_DELETED_RATIO = 0.3  # above the floor, losing more than this share of a file's lines is a rewrite
MAX_REFERENCE_HITS = 2000  # more references than this to removed symbols is refused, never guessed at
# A worker's own word that a case is meant, one line for each path or symbol, so that it cannot be a blanket one.
DECLARED = re.compile(r"^[ \t>*`-]*(REWRITE|REFORMAT|REMOVED|NEWLINE):[ \t]*(\S.*?)[ \t]*$", re.M)
# Leading whitespace is meaning in these, so `git diff -w` cannot tell a re-indent from a change of logic there.
INDENT_SENSITIVE = re.compile(r"(\.(py|pyi|ya?ml|mk|mdx?|coffee|haml|pug|slim)$)|(^|/)(GNUm|m|M)akefile$")
# Lockfiles and build output are written by tools: never a worker's choice of formatting.
GENERATED = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|uv\.lock)$"
                       r"|\.min\.js$|(^|/)(dist|build)/")
SOURCE_GLOBS = ("*.py", "*.pyi", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs")
# Every setting that changes the shape of diff or grep output is pinned, so that no configuration of the user's or the
# repository's can make the parser below see nothing and pass a broken change.
GIT_PINNED = ("-c", "color.ui=never", "-c", "color.diff=never", "-c", "color.grep=never", "-c", "diff.noprefix=false",
              "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false", "-c", "core.quotePath=false",
              "-c", "grep.fullName=false", "-c", "grep.column=false", "-c", "grep.lineNumber=false")
# Top-level only: methods share names across classes (`__init__`, `run`) and are no edge of the import graph.
PY_DEFINITION = re.compile(r"(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)\b", re.ASCII)
TS_EXPORT = re.compile(r"\s*export\s+(?:(?:default|declare|async|abstract)\s+)*(?:function\s*\*?\s*|class\s+|"
                       r"(?:const\s+enum|const|let|var|enum|type|interface)\s+)([A-Za-z_$][\w$]*)\b", re.ASCII)
NAME = r"[A-Za-z_$][\w$]*"


def declared(*texts):
    """{REWRITE, REFORMAT, REMOVED, NEWLINE: what TEXTS declare}: the symbol for REMOVED; for the others the rest of
    the line, which may go on to say why, a leading ./ and the punctuation around it dropped. Each text is read by
    itself, so a code fence one report leaves open hides nothing in the next."""
    found = {"REWRITE": set(), "REFORMAT": set(), "REMOVED": set(), "NEWLINE": set()}

    def bare(value):
        value = value.strip("`'\"")
        return (value[2:] if value.startswith("./") else value).rstrip(",;.:)`'\"")
    for text in texts:
        # A declaration stands at the start of a line of the report itself: one inside a pasted log declares nothing.
        for kind, value in DECLARED.findall(unfenced(text)):
            found[kind].add(bare(value.split()[0] if kind == "REMOVED" else value))
    return found


def meant(lines, paths):
    """The files among PATHS that the declarations LINES name: each line means one file, the longest path it begins
    with, so `cfg test.txt` is that file and not `cfg`."""
    files = set()
    for line in lines:
        fits = [path for path in paths if re.match(re.escape(path) + r"(?:$|[\s,;:)`'\"])", line)]
        if fits:
            files.add(max(fits, key=len))
    return files


def is_python(name):
    return name.endswith((".py", ".pyi"))


def defined_symbol(name, line):
    match = (PY_DEFINITION if is_python(name) else TS_EXPORT).match(line)
    return match[1] if match else None


def comment_only(name, line):
    return line.strip().startswith("#" if is_python(name) else ("//", "/*", "*"))


def mentions(clause, symbol):
    return re.search(r"(?<![\w$])%s(?![\w$])" % re.escape(symbol), clause, re.ASCII) is not None


PY_FROM = re.compile(r"^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*(?:\\\n[^\n#]*)*)", re.ASCII | re.M)


def gives(clause, symbol):
    """Whether an import or export CLAUSE gives out the name SYMBOL: `sym`, `type sym` or `other as sym`, never
    `sym as other`."""
    return any(part.split()[-1:] == [symbol] for part in re.sub(r"[()\\]", " ", clause).split(","))


def alt_stems(definition, stem):
    """Alternative module names when DEFINITION is a package entry (`index.*` in JS/TS or `__init__.py[i]` in Python)."""
    parts = definition.rsplit("/", 2)
    return {stem, parts[-2]} if len(parts) >= 2 and parts[-2] else {stem}


def _ts_path_matches(path, stems, importer=None, definition=None):
    raw = re.sub(r"\.[cm]?[jt]sx?$", "", path.rstrip("/"))
    if definition is not None:
        def_mod = re.sub(r"(\.d)?\.[cm]?[jt]sx?$", "", definition)
        is_pkg = def_mod == "index" or def_mod.endswith("/index")
        def_dir = def_mod[:-6] if def_mod.endswith("/index") else ("" if def_mod == "index" else None)
        is_rel = raw in (".", "..") or raw.startswith(("./", "../"))
        if is_pkg:
            if is_rel and importer is not None:
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(importer), raw))
                if resolved == ".":
                    resolved = ""
                return resolved == def_mod or (def_dir is not None and resolved == def_dir)
            # Strip tsconfig/bundler alias prefixes (@scope/, @/, ~/, #/, $/, or leading @~#$ on a single segment).
            bare = re.sub(r"^(?:[@~#$][^/]*/|/)", "", raw)
            bare = bare.lstrip("@~#$")
            if "/" in bare:
                return (bare == def_mod or (def_dir is not None and bare == def_dir)
                        or def_mod.endswith("/" + bare) or bare.endswith("/" + def_mod)
                        or (def_dir is not None and (def_dir.endswith("/" + bare) or (def_dir != "" and bare.endswith("/" + def_dir)))))
            return bare in stems
        if is_rel and importer is not None:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(importer), raw))
            if not resolved.startswith("..") and "/" in resolved and "/" in def_mod and resolved != def_mod:
                return False
    return raw.rsplit("/", 1)[-1] in stems


def ts_imports(source, symbol, stem=None, importer=None, definition=None):
    """Does a TypeScript or JavaScript file pull SYMBOL in from some module? With STEM, only an import that matches
    the defining module counts (resolving relative package imports against IMPORTER when given)."""
    stems = None if stem is None else {stem} if isinstance(stem, str) else set(stem)
    sym = re.escape(symbol)
    # import { a, sym as b } from / import sym from / import type { sym } from / export { sym } from. The clause is
    # anchored to real import shapes, so it cannot span from an unrelated `export const` to a later `from`.
    for clause, path in re.findall(r"\b(?:import|export)\s+(?:type\s+)?((?:%s\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+%s)|%s)\s*from\s*['\"]([^'\"]*)"
                                   % (NAME, NAME, NAME), source, re.ASCII):
        if stems is not None and not _ts_path_matches(path, stems, importer, definition):
            continue
        if mentions(clause, symbol):
            return True
        space = re.search(r"\*\s*as\s+(%s)" % NAME, clause, re.ASCII)  # `import * as api from './lib'`, then `api.sym`
        if stems is not None and space and re.search(
                r"(?<![\w$.])%s\s*\??\.\s*%s(?![\w$])" % (re.escape(space[1]), sym), source, re.ASCII):
            return True
    if stems is not None:
        return False
    # const { sym } = require('x') / const { sym } = await import('x')
    for clause in re.findall(r"(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|await\s+import)\s*\(", source, re.ASCII):
        if mentions(clause, symbol):
            return True
    # require('x').sym / (await import('x')).sym
    if re.search(r"(?:require|import)\s*\([^)]*\)\)?\s*\??\.\s*%s(?![\w$])" % sym, source, re.ASCII):
        return True
    # The names bound to whole modules: `import * as X`, `export * as X`, `const X = require(...)`.
    spaces = (re.findall(r"\*\s+as\s+(%s)\s+from\s*['\"]" % NAME, source, re.ASCII)
              + re.findall(r"(?:const|let|var)\s+(%s)\s*=\s*(?:require|await\s+import)\s*\(" % NAME, source, re.ASCII))
    return any(re.search(r"(?<![\w$.])%s\s*\??\.\s*%s(?![\w$])" % (re.escape(space), sym), source, re.ASCII)
               for space in spaces)


def py_imports(source, symbol, definition, exact=False, importer=None):
    """Does a Python file pull SYMBOL in: `from m import sym`, `from m import *` of the defining module, or `alias.sym`?
    With EXACT, `from m import sym` counts only when m is the defining module."""
    def_mod = re.sub(r"\.pyi?$", "", definition)
    stem = def_mod.rsplit("/", 1)[-1]
    is_pkg = stem == "__init__"
    def_dir = def_mod[:-9] if def_mod.endswith("/__init__") else ("" if def_mod == "__init__" else None)
    stems = alt_stems(definition, stem) if is_pkg else {stem}

    def py_matches(module, child=None):
        if module.startswith(".") and importer is not None:
            dots = len(module) - len(module.lstrip("."))
            base_parts = [p for p in posixpath.dirname(importer).split("/") if p]
            if dots - 1 > len(base_parts):
                return False
            prefix = base_parts[:len(base_parts) - (dots - 1)]
            tail = [p for p in module[dots:].split(".") if p]
            if child:
                tail.append(child)
            resolved = "/".join(prefix + tail)
            return resolved == def_mod or (def_dir is not None and resolved == def_dir)
        parts = [p for p in module.lstrip(".").split(".") if p]
        if child:
            parts.append(child)
        mod_path = "/".join(parts)
        if is_pkg:
            if "/" in mod_path:
                return (mod_path == def_mod or (def_dir is not None and (mod_path == def_dir or def_dir.endswith("/" + mod_path)
                        or (def_dir != "" and mod_path.endswith("/" + def_dir))))
                        or def_mod.endswith("/" + mod_path) or mod_path.endswith("/" + def_mod))
            return mod_path in stems
        if "/" in mod_path and "/" in def_mod:
            return mod_path == def_mod or def_mod.endswith("/" + mod_path)
        return (parts[-1] if parts else "") in stems

    bound = []
    for module, clause in PY_FROM.findall(source):
        clause = re.sub(r"[()\\]", " ", clause)
        if clause.strip() == "*":
            if py_matches(module):
                return True
            continue
        if mentions(clause, symbol) and (not exact or py_matches(module)):
            return True
        for part in clause.split(","):  # `from pkg import api [as a]`: only the defining module binds `a.sym`
            imported = re.fullmatch(r"\s*(\w+)(?:\s+as\s+(\w+))?\s*", part, re.ASCII)
            if imported and py_matches(module, imported[1]):
                bound.append(imported[2] or imported[1])
    for names in re.findall(r"^[ \t]*import[ \t]+([^\n#]+)", source, re.ASCII | re.M):
        for part in names.split(","):
            alias = re.fullmatch(r"\s*([\w.]+)(?:\s+as\s+(\w+))?\s*", part, re.ASCII)
            # `import requests` does not make `requests.get` a caller of a `get` removed elsewhere.
            if alias and py_matches(alias[1]):
                bound.append(alias[2] or alias[1])
    return any(re.search(r"(?<![\w.])%s(?:\.\w+)*\.%s\b" % (re.escape(name), re.escape(symbol)), source, re.ASCII)
               for name in bound)


def imports_symbol(name, source, symbol, definition, exact=False):
    """Whether file NAME, holding SOURCE, plausibly refers to SYMBOL removed from the file DEFINITION. With EXACT,
    only an import that names the defining module counts: for a symbol another file defines too."""
    code = "\n".join("" if comment_only(name, line) else line for line in source.split("\n"))
    if is_python(name):
        return py_imports(code, symbol, definition, exact, importer=name)
    stem = re.sub(r"(\.d)?\.[cm]?[jt]sx?$", "", definition.rsplit("/", 1)[-1])
    stems = alt_stems(definition, stem) if stem == "index" else {stem}
    return ts_imports(code, symbol, stems if exact else None, importer=name, definition=definition)


def removed_public_symbols(diff, moved=None):
    """{symbol: the files it was removed from} for the public symbols a unified diff removes. One the same file defines
    again (a changed signature) is not removed from it; one a file loses and only another file defines is put in
    MOVED, when given, with the files it left."""
    removed, added, old, new = {}, {}, "", ""
    for line in diff.split("\n"):
        # An unquoted Git patch header ends in a tab when its path has spaces.
        if header := re.fullmatch(r"--- (?:a/([^\t]+)\t?|/dev/null)", line):
            old = header[1] or ""
        elif header := re.fullmatch(r"\+\+\+ (?:b/([^\t]+)\t?|/dev/null)", line):
            new = header[1] or ""
        elif line.startswith("-") and old:
            if symbol := defined_symbol(old, line[1:]):
                removed.setdefault(symbol, []).append(old)
        elif line.startswith("+") and new:
            if symbol := defined_symbol(new, line[1:]):
                added.setdefault(symbol, set()).add(new)
    left = {symbol: [name for name in dict.fromkeys(names) if name not in added.get(symbol, ())]
            for symbol, names in removed.items()}
    if moved is not None:
        moved.update({symbol: names for symbol, names in left.items() if names and symbol in added})
    return {symbol: names for symbol, names in left.items() if names and symbol not in added}


def caller_issues(root, revisions, excluded, allowed):
    """A line for each file that still imports a public symbol the candidate removes. ALLOWED symbols are declared."""
    spec = ["--", *(":(top)" + glob for glob in SOURCE_GLOBS), *excluded]
    moved = {}
    removed = removed_public_symbols(git(
        root, *GIT_PINNED, "diff", "--no-ext-diff", "--no-color", "--no-textconv", "--no-renames", "--src-prefix=a/",
        "--dst-prefix=b/", "--unified=0", *revisions, *spec).decode(errors="replace"), moved)
    removed = {symbol: names for symbol, names in {**moved, **removed}.items() if symbol not in allowed}
    if not removed:
        return []
    # One grep for every removed symbol. Exit status 1 is "no match"; anything else is an error, never a pass.
    env = clean_env()
    env["LC_ALL"] = "C"
    grep = subprocess.run(["git", "-C", str(root), *GIT_PINNED, "grep", "--no-color", "-z", "-n", "-I", "-F", "-w", "--untracked",
                           *(arg for symbol in removed for arg in ("-e", symbol)), *spec], capture_output=True, env=env)
    if grep.returncode not in (0, 1):
        raise ValueError("cannot look for callers of removed symbols: "
                         + (grep.stderr.decode(errors="replace").strip() or "git grep failed"))
    hits = []
    for hit in grep.stdout.decode(errors="replace").split("\n"):
        name, _, rest = hit.partition("\0")
        number, _, text = rest.partition("\0")
        if name and number.isdigit():
            hits.append((name, number, text))
    def provides(name, symbol):
        """Whether the file a symbol left still gives it to its importers under that name: a Python module that
        imports it or binds the name at the top level, a TypeScript one that exports it. A TypeScript import alone
        exports nothing, `sym as other` gives out another name, and a mention in a string or a call is none of that."""
        path = root / name
        if not path.is_file():
            return False
        code = "\n".join("" if comment_only(name, line) else line
                         for line in path.read_text(encoding="utf-8", errors="replace").split("\n"))
        sym = re.escape(symbol)
        if is_python(name):
            return (any(gives(clause, symbol) for _, clause in PY_FROM.findall(code))
                    or re.search(r"^%s[ \t]*(?::[^=\n]*)?=" % sym, code, re.M | re.ASCII) is not None)
        return any(gives(clause, symbol) for clause in re.findall(r"\bexport\s*(?:type\s*)?\{([^}]*)\}", code, re.ASCII))

    by_symbol, elsewhere = {}, set()
    for symbol, origin in ((symbol, origin) for symbol, names in removed.items() for origin in names):
        found = [hit for hit in hits if mentions(hit[2], symbol)]
        # Still defined somewhere (`def main` in another script, a second `export const config`, the file it moved
        # to): a caller may bind to that one, and a grep cannot tell a broken reference from a working one. What it
        # can tell is an import that names the module the symbol left, and that one is broken unless a re-export
        # stayed behind. Each module the symbol left is asked for itself.
        if symbol in moved or any(defined_symbol(name, text) == symbol for name, _, text in found):
            if provides(origin, symbol):
                continue
            elsewhere.add((symbol, origin))
        if found:
            by_symbol[symbol, origin] = found
    total = sum(map(len, by_symbol.values()))
    if total > MAX_REFERENCE_HITS:
        return ["%d references to removed public symbols (%s) are more than the %d this check reads; check the callers "
                "by hand, then declare each symbol with a `REMOVED: <symbol>` line in the READY report"
                % (total, ", ".join(dict.fromkeys(symbol for symbol, _ in by_symbol)), MAX_REFERENCE_HITS)]
    issues, sources, named = [], {}, set()
    for (symbol, origin), found in by_symbol.items():
        for name, number, text in found:
            if comment_only(name, text) or (name, symbol) in named:
                continue
            if name not in sources:
                sources[name] = (root / name).read_text(encoding="utf-8", errors="replace")
            if imports_symbol(name, sources[name], symbol, origin, (symbol, origin) in elsewhere):
                named.add((name, symbol))
                issues.append('%s:%s still refers to "%s", which the candidate removes from %s: update or remove this caller, '
                              "or declare `REMOVED: %s` in the READY report if the reference is to another %s"
                              % (name, number, symbol, origin, symbol, symbol))
    return issues


def hygiene_issues(root, base, commit, reports, skip):
    """What is wrong with the shape of the candidate's change against BASE, one line for each defect: a file rewritten
    whole, a trailing newline lost, formatting mixed with real changes, a removed public symbol something still
    imports. COMMIT is the candidate's, or None when the candidate is the checkout's own files. REPORTS are the texts of
    the READY reports and the coordinator's allowances, whose REWRITE:, REFORMAT: and REMOVED: lines declare a case as meant. SKIP is what `not_source`
    returns."""
    revisions = [base, commit] if commit else [base]
    excluded = [":(top,literal,exclude)" + os.fsdecode(b"/".join(path)) for path in skip]

    def stat(*flags):
        fields = git(root, "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--numstat", "-z", *flags, *revisions,
                     "--", ":/", *excluded).split(b"\0")
        counts = {}
        for field in fields:
            added, deleted, name = (field.split(b"\t", 2) + [b"", b""])[:3]
            if added.isdigit() and deleted.isdigit():  # a binary file has "-" for both
                counts[os.fsdecode(name)] = (int(added), int(deleted))
        return counts

    def before(name):
        return git(root, "cat-file", "-p", f"{base}:{name}", optional=True)

    def after(name):
        if commit:
            return git(root, "cat-file", "-p", f"{commit}:{name}", optional=True)
        path = root / name
        return path.read_bytes() if path.is_file() and not path.is_symlink() else None

    changed, unspaced = stat(), stat("-w")
    new = {os.fsdecode(name) for name in git(root, "diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", *revisions,
                                             "--", ":/", *excluded).split(b"\0") if name}
    if not commit:  # the checkout's own files: an untracked one is a new file no diff shows
        new |= {os.fsdecode(name) for name in git(root, "ls-files", "--others", "--exclude-standard", "-z",
                                                  "--", ":/", *excluded).split(b"\0") if name}
    # Whitespace only: the file has a change, and it disappears under -w.
    blank = {name for name, (added, deleted) in changed.items() if added + deleted and not sum(unspaced.get(name, (0, 0)))}
    allowed, issues = declared(*reports), []
    rewritten, unended, respaced = (meant(allowed[kind], set(changed) | new) for kind in ("REWRITE", "NEWLINE", "REFORMAT"))
    for name, (_, deleted) in sorted(changed.items()):
        if name in new:
            continue
        old, now = before(name), after(name)
        if old is None or now is None:  # a file deleted, or moved (a rename is a deletion here), is no rewrite
            continue
        lines = old.count(b"\n") + (not old.endswith(b"\n")) if old else 0
        if (name not in blank and deleted and lines >= REWRITE_MIN_LINES and deleted / lines > REWRITE_MAX_DELETED_RATIO
                and name not in rewritten):
            issues.append("%s lost %d of its %d lines (%d%%): that is a rewrite. Restore the file and make only the intended "
                          "change with targeted edits, or declare `REWRITE: %s` in the READY report if the task is to rewrite it"
                          % (name, deleted, lines, round(100 * deleted / lines), name))
        if (old.endswith(b"\n") and now and b"\0" not in now and not now.endswith(b"\n")
                and name not in unended):
            issues.append("%s lost the newline at its end: put it back, or declare `NEWLINE: %s` in the READY report if "
                          "the file is meant to end without one" % (name, name))
    reformatted = sorted(name for name in blank if not INDENT_SENSITIVE.search(name) and not GENERATED.search(name)
                         and name not in respaced)
    real = sorted({name for name in changed if name not in blank or INDENT_SENSITIVE.search(name)} | new)
    if reformatted and real:
        issues.append("%s changed in whitespace only, beside real changes (%s): revert the formatting there, or declare "
                      "each with a `REFORMAT: <path>` line in the READY report if it is meant"
                      % (", ".join(reformatted), ", ".join(real[:5]) + (" and more" if len(real) > 5 else "")))
    return issues + caller_issues(root, revisions, excluded, allowed["REMOVED"])


def allowances(given):
    """`--allow` values as declaration lines, KIND: target. The coordinator's own word on a case it has checked: the
    name matching of the caller check resolves no module path, so it can name a caller that imports another symbol
    of that name, and nobody should have to wake a worker to say so."""
    lines = []
    for value in given or ():
        kind, _, target = value.partition(":")
        if (kind.upper() not in {"REWRITE", "REFORMAT", "REMOVED", "NEWLINE"} or not target.strip() or "\n" in target
                or (kind.upper() == "REMOVED" and any(c.isspace() for c in target.strip()))):
            raise ValueError("--allow takes rewrite:<path>, reformat:<path>, newline:<path> or removed:<symbol>")
        lines.append("%s: %s" % (kind.upper(), target.strip()))
    return list(dict.fromkeys(lines))


def check_hygiene(run, root, base, commit, recorded, skip, allowed=()):
    """Raise when the candidate's change has a hygiene defect that neither its workers declared in their READY reports
    nor the coordinator allowed (ALLOWED, what `allowances` returns)."""
    reports = {seq for seq, _ in recorded.values()}
    texts = [*(post["text"] for post in load(run)[1] if post["seq"] in reports), "\n".join(allowed)]
    issues = hygiene_issues(root, base, commit, texts, skip)
    if issues:
        raise ValueError("the candidate is not ready for a verifier:\n- %s\nSend each to its worker; a new READY and a new "
                         "`prepare` follow the fix. One you have checked yourself, such as a caller a passing type check "
                         "clears, you can allow on `prepare` with --allow rewrite:<path>, reformat:<path>, "
                         "newline:<path> or removed:<symbol>: the candidate records it and the verifier reports it" % "\n- ".join(issues))


def check_current(run, candidate, *, allow_closed=False):
    """Raise unless a passing candidate still describes the reports and the sources it ran on."""
    if not candidate.get("accepted"):
        return check_inputs(run, candidate)
    # Accepted: its checkout may be gone, and the project itself now holds what was tested.
    project = Path(candidate["project"])
    recorded = inputs(run, candidate["mode"], subset_of(candidate), allow_closed=allow_closed)
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


def prepare(run, project, mode, checks, onto=None, subset=None, baseline=False, allowed=()):
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
            # Whatever chain it came down: `ready` reads only the members a worker waits for.
            state, posts = load(run)
            try:
                held = withdrawn_in(integration, state["members"], state["members"], posts, commit, base)
            except SystemExit as error:
                raise ValueError(str(error)) from None
            if held:
                raise ValueError("the candidate holds @%s's commit %s, which had not passed when @%s was retired; it came in with "
                                 "%s. Have that work rebuilt without it, then prepare again" % (
                                     held[0], held[1][:12], held[0], ", ".join(
                                         "@" + name for name, (_, revision) in recorded.items() if revision and git(
                                             integration, "merge-base", "--is-ancestor", held[1], revision, optional=True) is not None)
                                     or "a member's commit"))
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
            check_hygiene(run, integration, base, commit, recorded, [run_data], allowed)
        candidate = {
            "candidate": identifier, "project": str(project), "path": str(work),
            "mode": mode, "base": base, "onto": onto, "commit": commit, "checks": checks or [], "no_checks": checks is None,
            "branch": os.fsdecode(branch).strip() if branch else None,
            "worktree": str(integration) if integration else None,
            "inputs": recorded, "digest": source_digest(work, pointers=mode == "isolated"),
            # Every file as prepared: the digest reads a clean submodule of an isolated checkout as its commit, so one
            # filled in afterwards, with files the landed commit will not bring, would go unseen.
            "exact": source_digest(work) if mode == "isolated" else None,
            "partial": subset is not None, "members": sorted(recorded), "baseline": baseline,
        }
        if allowed:  # the record of what the coordinator let through, for the verifier's report and the export
            candidate["allowed"] = list(allowed)
        if mode != "isolated":
            # A shared candidate is the checkout's own files, compared with its HEAD. Outside a repository, or in one
            # with no commit yet, there is nothing to compare them with. Scanned after the fingerprint above was
            # taken: an edit made since is one `test` refuses, so no source passes that this scan did not read.
            found = repository(project)
            if found is not None and git(project, "rev-parse", "--verify", "-q", "HEAD^{commit}", optional=True):
                check_hygiene(run, found[0], "HEAD", None, recorded, not_source(found), allowed)
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


DEFAULT_CHECK_TIMEOUT = 900
DEFAULT_ATTEMPT_TIMEOUT = 3600
MAX_CHECK_OUTPUT = 16 << 20


class CheckOutputLimit(ValueError):
    pass


def check_output(process, command, timeout, output):
    deadline = None if timeout is None else time.monotonic() + timeout
    remaining_bytes = MAX_CHECK_OUTPUT
    fd = process.stdout.fileno()
    with selectors.DefaultSelector() as events:
        events.register(process.stdout, selectors.EVENT_READ)
        while process.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout)
            if not events.select(0.05 if deadline is None else max(0, min(0.05, deadline - time.monotonic()))):
                continue
            if process.poll() is not None:
                break
            chunk = os.read(fd, 65536)
            if not chunk:
                process.wait(timeout=None if deadline is None else max(0, deadline - time.monotonic()))
                break
            output.write(chunk[:remaining_bytes])
            remaining_bytes -= len(chunk)
            if remaining_bytes < 0:
                raise CheckOutputLimit(f"output exceeded {MAX_CHECK_OUTPUT >> 20} MiB")
    cleanup(process)
    # Pipes can still contain the shell's final output, or be held open by a detached helper.
    os.set_blocking(fd, False)
    while remaining_bytes:
        try:
            chunk = os.read(fd, min(65536, remaining_bytes))
        except BlockingIOError:
            break
        if not chunk:
            break
        output.write(chunk)
        remaining_bytes -= len(chunk)
    return process.returncode


def run_check(command, cwd, timeout, output=None, *, output_dir=None):
    """Run a check in its own process group, streaming combined output to a bounded log when supplied."""
    def interrupted(number, _frame):
        raise SystemExit(128 + number)

    # The group no longer dies with this process, so a signal sent to it has to reach the cleanup below,
    # and the handlers are in place before the check can start.
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGHUP)}
    previous[signal.SIGINT] = signal.getsignal(signal.SIGINT)  # cleanup ignores it; the finally restores it
    process = None
    try:
        env = clean_env()
        if output_dir is not None:
            env["SWARM_VERIFY_OUTPUT_DIR"] = str(output_dir)
        process = subprocess.Popen(["/bin/sh", "-c", command], cwd=cwd, stdin=subprocess.DEVNULL,
                                   stdout=None if output is None else subprocess.PIPE,
                                   stderr=None if output is None else subprocess.STDOUT,
                                   env=env, start_new_session=True)
        if output is not None:
            return check_output(process, command, timeout, output)
        returncode = process.wait(timeout=timeout)
        cleanup(process)  # what it left in the background ends with it too
        return returncode
    except BaseException:
        if process is not None:
            cleanup(process)
        raise
    finally:
        if process is not None and process.stdout is not None:
            process.stdout.close()
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
        tail = file.read()
        window = (tail[:-1] if tail.endswith(b"\n") else tail).split(b"\n") if count else []
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


# The baseline comparison: a check that fails on the candidate is run again on the candidate's base, and waived only
# when it fails there in the same way. Ported from OpenSwarm's verify/runner.ts (MIT, Copyright (c) 2026 Heewon Oh).
DEPENDENCY_INPUTS = {"package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml",
                     "Cargo.lock", "go.mod", "go.sum", "requirements.txt", "pyproject.toml", "uv.lock", "poetry.lock",
                     ".npmrc", ".yarnrc.yml", "pip.conf"}  # where packages come from decides which ones arrive
DEPENDENCY_NAMES = re.compile(r"(requirements|constraints)[\w.-]*\.(txt|in)|Pipfile|setup\.(py|cfg)|Gemfile|pom\.xml|"
                              r"build\.gradle(\.kts)?|.*\.lock")
COMPARED_BYTES = 8 << 20  # a log longer than this is not compared, and so not waived: both are read whole
# A line that counts and names nothing: "1 failed, <N> passed in <DURATION>", "Ran 3 tests in <DURATION>", "FAILED
# (failures=1)", a row of progress marks. Two runs that agree only on such lines may have failed in different tests.
COUNTS_ONLY = re.compile(r"[=\-\s]*(?:(?:(?:\d+|<N>) [a-z]+,? ?)+(?:in <DURATION>)?|Ran \d+ tests? in <DURATION>|"
                         r"(?:FAILED|OK)(?: \([\w=, ]*\))?|[.sxXFEP]+)?[=\-\s]*")
# A line that says what failed: a failure word beside a test's id (`a::b`, `(pkg.mod.Case.test)`, `test_x`, `TestX`)
# or a place in a file (`src/a.rs:4`). A banner, a count, `make: *** [test] Error 1` or the path of a log says none
# of that.
# ponytail: a heuristic over free text; read a structured report (JUnit XML) if one tool's failures slip through.
FAILURE_WORD = re.compile(r"\b(?:FAIL(?:ED|URE|S)?|ERROR|[Ee]rror\w*|\w*Exception|panicked|assert\w*|not ok)\b|[✗✕✘×]")
FAILURE_ID = re.compile(r"\w::\w|\(\w+(?:\.\w+)+\)|[\w/-][\w./-]{0,200}\.\w{1,16}:\d+|\b[Tt]est(?:_\w+|[A-Z]\w*)")


def names_failure(line):
    line = line[:4000]  # no test's name is longer, and a line of megabytes is read no further
    return bool(FAILURE_WORD.search(line) and FAILURE_ID.search(line)) and not COUNTS_ONLY.fullmatch(line)


# The toolchain could not run: that is no verdict on the change, on either side, so it is never waived.
ENVIRONMENT_FAILURE = [re.compile(pattern, flags) for pattern, flags in (
    (r"ModuleNotFoundError:\s*No module named\b", re.I), (r"ImportError:\s*No module named\b", re.I),
    (r"Cannot find module ['\"]", re.I), (r"Failed to initialize cache at", re.I),
    (r"(?:^|[^A-Za-z]|\x1b\[[0-9;]*m)(?:error|×)(?:\x1b\[[0-9;]*m)*:?(?:\x1b\[[0-9;]*m)*[ \t]+Failed to (?:download|fetch|prepare|sync)\b", re.M),
    (r"Network connectivity is disabled, but the\s+requested data wasn't found in the cache", 0),
    (r"No solution found when resolving dependencies", re.I),
    (r"(?:Network is unreachable|Temporary failure in name resolution|Could not resolve host|nodename nor servname provided)", re.I),
    (r"No virtual environment found", re.I), (r"command not found:? (?:uv|python3?|pytest|ruff|npm|cargo|go)\b", re.I),
    (r"could not find [`']?Cargo\.toml", re.I), (r"failed to (?:load|read) manifest for workspace member", re.I),
    (r"Cargo\.toml.*(?:No such file or directory|os error 2)", re.I),
    # A shell that could not start a program, whatever exit code the command around it then gave.
    (r"^\S+: (?:(?:line )?\d+: )?\S+: (?:command not found|not found|No such file or directory|Permission denied)\s*$", re.M),
    (r"^zsh: (?:command not found|no such file or directory|permission denied): ", re.M))]


def normalized_failure(output, roots):
    """A check's OUTPUT with what differs between two runs of one failure taken out: the checkouts' own paths (ROOTS),
    colours, durations, how many tests passed or were skipped, progress lines, and the order in which parallel
    workers finished. What names the failure stays, so a second failure or a changed assertion still differs."""
    def totals(counts):  # `failed` and `error` counts stay
        return re.sub(r"\d+ (passed|skipped|deselected|xfailed|xpassed|warnings?)", r"<N> \1", counts)

    for root in sorted(filter(None, roots), key=len, reverse=True):  # a nested path before the one that holds it
        output = output.replace(root, "<ROOT>")
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)
    output = re.sub(r"(=+ .*? in )\d+(?:\.\d+)?s( =+)", lambda m: totals(m[1]) + "<DURATION>" + m[2], output)
    output = re.sub(r"^(\d+ [a-z]+(?:, \d+ [a-z]+)* in )\d+(?:\.\d+)?s(?: \(\d+:\d{2}:\d{2}\))?$",
                    lambda m: totals(m[1]) + "<DURATION>", output, flags=re.M)
    output = re.sub(r"^[.sxXFEP]+ *\[ *\d+%\]\n?", "", output, flags=re.M)
    output = re.sub(r"(Ran \d+ tests? in )\d+(?:\.\d+)?s", r"\1<DURATION>", output)
    output = re.sub(r"(finished in )\d+(?:\.\d+)?s", r"\1<DURATION>", output, flags=re.I)
    output = re.sub(r"\[gw\d+\]", "[gw<WORKER>]", output)

    def ordered(text, heading, until, split):
        found = re.search(heading, text, re.M)
        if not found:
            return text
        end = re.search(until, text[found.end():], re.M)
        end = len(text) if end is None else found.end() + end.start()
        return text[:found.end()] + split(text[found.end():end]) + text[end:]

    output = ordered(output, r"^={3,} FAILURES ={3,}\n", r"^={3,} .* ={3,}$",
                     lambda body: "".join(sorted(filter(None, re.split(r"(?=^_{8,}.*$)", body, flags=re.M)))))
    return ordered(output, r"^={3,} short test summary info ={3,}\n", r"^={3,} .* ={3,}$",
                   lambda body: "".join(line + "\n" for line in sorted(filter(None, body.split("\n")))))


def environment_failure(output):
    return any(pattern.search(output) for pattern in ENVIRONMENT_FAILURE)


BASELINES_FILE = ".baselines.json"


def record_baseline(run, name, add=True):
    """Track baseline worktree directory names created by verification so `board.py prune` cleans only ours."""
    path = Path(run) / BASELINES_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        names = [entry for entry in raw if isinstance(entry, str)] if isinstance(raw, list) else []
    except (OSError, ValueError):
        names = []
    if add:
        if name not in names:
            names.append(name)
    else:
        names = [entry for entry in names if entry != name]
    if names:
        atomic_write(path, json.dumps(sorted(names)) + "\n")
    else:
        try:
            path.unlink()
        except OSError:
            pass


def same_on_base(run, project, candidate, ran, timeout, deadline, candidate_output):
    """{index in RAN: (whether that failed check fails on the candidate's base in the same way, why)}. RAN is every
    check as it ended here: (command, exit code, log). The base runs them once, in order, up to the last one in
    question, so what an earlier check sets up is there on both sides. The same exit code is not enough: the candidate
    may hold the old failure and a new one, so only identical failure output is waived, and a check with unstable or
    no output stays failed. Once a check ends or prints otherwise on the base the two runs are no longer set up alike,
    and nothing after it is waived."""
    ran = ran[:next((index for index, (_, code, _) in enumerate(ran) if code is None), len(ran))]
    verdicts = {}
    for index, (_, returncode, log) in enumerate(ran):
        if not returncode:
            continue
        if log.stat().st_size > COMPARED_BYTES:
            verdicts[index] = (False, "its output is over %d MB, more than is compared" % (COMPARED_BYTES >> 20))
        # 126 and 127 are the shell's own: the command could not be run, or was not found.
        elif returncode in (126, 127) or environment_failure(log.read_bytes().decode(errors="replace")):
            verdicts[index] = (False, "the check could not run here (a missing module, tool or network), which is no result "
                                      "on either side")
    asked = [index for index, (_, returncode, _) in enumerate(ran) if returncode and index not in verdicts]
    if not asked:
        return verdicts
    changed = git(candidate["worktree"], "diff", "--no-renames", "--name-only", "-z", candidate["base"], candidate["commit"])
    inputs = sorted({os.fsdecode(name) for name in changed.split(b"\0") if name.rsplit(b"/", 1)[-1].decode(errors="replace")
                     in DEPENDENCY_INPUTS or DEPENDENCY_NAMES.fullmatch(name.rsplit(b"/", 1)[-1].decode(errors="replace"))})
    if inputs:
        why = "the candidate changes %s, so the base runs with other dependencies" % ", ".join(inputs)
        return {**verdicts, **dict.fromkeys(asked, (False, why))}
    short, diverged = candidate["base"][:12], None
    with tempfile.TemporaryDirectory(dir=run, prefix=f"baseline-{candidate['candidate']}-") as base_dir, \
         tempfile.TemporaryDirectory(dir=run, prefix="baseline-output-") as output_dir:
        baseline = Path(base_dir)
        record_baseline(run, baseline.name, add=True)
        try:
            git(project, "worktree", "add", "--detach", str(baseline), candidate["base"])
            work = baseline / Path(candidate["path"]).relative_to(candidate["worktree"])
            roots = [str(Path(candidate["worktree"])), str(Path(candidate["worktree"]).resolve()),
                     str(baseline), str(baseline.resolve()), str(candidate_output), output_dir]

            def printed(path):
                return None if path.stat().st_size > COMPARED_BYTES else normalized_failure(path.read_bytes().decode(errors="replace"), roots)
            for index, (command, returncode, log) in enumerate(ran[:asked[-1] + 1]):
                if diverged is not None:
                    if index in asked:
                        verdicts[index] = (False, "an earlier check ends or prints otherwise on the base, so the two runs are not "
                                                  "set up alike: " + diverged)
                    continue
                base_log = log.with_name(log.stem + "-base.log")
                try:
                    with base_log.open("wb") as output:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise subprocess.TimeoutExpired(command, 0)
                        on_base = run_check(command, work, min(timeout, remaining), output, output_dir=output_dir)
                except (subprocess.TimeoutExpired, CheckOutputLimit):
                    on_base = None
                here, there = printed(log), printed(base_log)
                if on_base != returncode or here is None or here != there:
                    diverged = command
                if index not in asked:
                    continue
                if on_base is None:
                    why = "it timed out on the base"
                elif on_base == 0:
                    why = "it passes on the base %s" % short
                elif on_base != returncode:
                    why = "it exits %d on the base %s and %d here" % (on_base, short, returncode)
                elif there is None:
                    why = "its output on the base is over %d MB, more than is compared" % (COMPARED_BYTES >> 20)
                elif here != there:
                    why = "it fails on the base %s too, with other output (log: %s)" % (short, base_log)
                # Nothing, progress marks, counts, a banner: the same count may be another test on each side.
                elif not any(map(names_failure, here.split("\n"))):
                    why = "it prints nothing that names a failure on either side, so nothing shows the two are one"
                else:
                    verdicts[index] = (True, "it fails on the base %s with the same output (log: %s)" % (short, base_log))
                    continue
                verdicts[index] = (False, why)
        except (OSError, ValueError) as error:  # no such folder on the base, a worktree Git could not make: no comparison
            for index in asked:
                verdicts.setdefault(index, (False, "the base could not be checked: %s" % error))
        finally:
            if baseline.exists():
                git(project, "worktree", "remove", "--force", str(baseline), optional=True)
            if not baseline.exists():
                record_baseline(run, baseline.name, add=False)
    return verdicts


def positive_timeout(raw, name):
    try:
        timeout = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a positive number") from None
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError(f"{name} must be a positive number")
    return timeout


def untracked_sources(project):
    found = repository(project)
    if found is None:
        return set()
    skip = not_source(found)
    return {name for name in git(found[0], "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")
            if name and not in_worktree(name, skip)}


def test_candidate(run, project, identifier, verifier, timeout_arg=None):
    verifier = verifier.lstrip("@").lower()
    timeout = (positive_timeout(timeout_arg, "--timeout") if timeout_arg is not None else positive_timeout(
        os.environ.get("SWARM_VERIFY_TIMEOUT", "").strip() or str(DEFAULT_CHECK_TIMEOUT), "SWARM_VERIFY_TIMEOUT"))
    attempt_timeout = positive_timeout(
        os.environ.get("SWARM_VERIFY_ATTEMPT_TIMEOUT", "").strip() or str(max(DEFAULT_ATTEMPT_TIMEOUT, timeout)),
        "SWARM_VERIFY_ATTEMPT_TIMEOUT")
    deadline = time.monotonic() + attempt_timeout
    timing = os.environ.get("SWARM_VERIFY_TIMINGS") == "1"
    started_attempt = time.monotonic()

    attempt = uuid.uuid4().hex
    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        active_verifier(run, verifier)
        if candidate.get("accepted"):
            raise ValueError("this candidate was accepted; prepare a new candidate to test again")
        check_inputs(run, candidate)  # before anything is cleared: a test that cannot run voids nothing
        candidate.pop("verified_by", None)
        candidate.pop("waived", None)  # the last attempt's: this one says anew what it waives
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

    work = Path(candidate["path"])
    untracked_before = untracked_sources(work) if candidate["checks"] else set()
    started_checks = time.monotonic()
    if timing:
        print(f"Verification setup and source validation: {started_checks - started_attempt:.2f}s")
    # Under the run folder, so inside the project's .swarm folder: never in the candidate's checkout, where the
    # fingerprint would read them, and never staged by `commit`. An earlier attempt's logs stay.
    logs = run / "checks"
    logs.mkdir(exist_ok=True)
    number = reserve(logs, identifier) if candidate["checks"] else None
    output_dir = run / "check-output" / f"{identifier}-attempt{number:02d}" if number is not None else None
    if output_dir is not None:
        output_dir.mkdir(parents=True)
    failed, waived, ran, aborted = [], [], [], {}
    for index, command in enumerate(candidate["checks"], 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failed.extend(f"{skipped} (not run: attempt deadline reached)" for skipped in candidate["checks"][index - 1:])
            break
        print(f"$ {command}", flush=True)
        log = logs / log_name(identifier, number, index)
        started = time.monotonic()
        try:
            with log.open("wb") as output:
                returncode = run_check(command, candidate["path"], min(timeout, remaining), output, output_dir=output_dir)
        except subprocess.TimeoutExpired:
            returncode = None
            aborted[index - 1] = f"timed out after {timeout:g}s" if timeout <= remaining else "timed out at the attempt deadline"
        except CheckOutputLimit as error:
            returncode = None
            aborted[index - 1] = str(error)
        elapsed, size, count = time.monotonic() - started, log.stat().st_size, lines_in(log)
        shown_lines, tail = excerpt(log, count, *(
            (FAIL_LINES, FAIL_BYTES) if returncode != 0 else
            (WHOLE_LINES, WHOLE_BYTES) if count <= WHOLE_LINES and size <= WHOLE_BYTES else (PASS_LINES, PASS_BYTES)))
        print("%s in %.1fs, %d lines (%d bytes) of output, log: %s" % (
            aborted[index - 1].capitalize() if returncode is None else f"Exit {returncode}", elapsed, count, size, log),
            flush=True)
        if tail:
            # As bytes: the output may hold what the terminal's encoding cannot.
            sys.stdout.buffer.write(tail.encode() + b"\n")
            sys.stdout.buffer.flush()
        if returncode != 0:
            print(f"(the last {shown_lines} of {count} lines; Grep the log for the rest, then Read the lines you need: {log})",
                  flush=True)
        ran.append((command, returncode, log))
    # The base is asked only once every check has run here: its replay of the earlier checks may write what a later
    # check reads outside the checkout. Once for the attempt, however many checks failed.
    verdicts = (same_on_base(run, project, candidate, ran, timeout, deadline, output_dir)
                if candidate.get("baseline") else {})
    for index, (command, returncode, log) in enumerate(ran):
        if index in aborted:
            failed.append(f"{command} ({aborted[index]})")
        elif index in verdicts:
            same, why = verdicts[index]
            print("$ %s\n%s: %s" % (command, "Waived, as no failure of the candidate's" if same else "Not waived", why),
                  flush=True)
            (waived if same else failed).append(command)
        elif returncode:
            failed.append(command)
    started_validation = time.monotonic()
    if timing:
        print(f"Verification checks and baseline replay: {started_validation - started_checks:.2f}s")
    if failed:
        # Every check ran: a cycle that stops at the first failure hides the rest until the next candidate.
        raise ValueError("verification failed: " + "; ".join(failed))

    with board_lock(run):
        candidate = candidate_for(run, project, identifier)
        if candidate.get("attempt") != attempt:
            raise ValueError("the verification attempt was withdrawn or superseded")
        active_verifier(run, verifier)
        if candidate["checks"]:
            created = sorted(untracked_sources(work) - untracked_before)
            if created:
                names = ", ".join(shown(os.fsdecode(name)) for name in created[:8])
                more = f" and {len(created) - 8} more" if len(created) > 8 else ""
                raise ValueError(f"verification checks left new untracked files: {names}{more}. "
                                 "Remove the generated files. Prepare a candidate with checks that write to "
                                 "$SWARM_VERIFY_OUTPUT_DIR or clean up before exit, or add a targeted ignore rule.")
        check_inputs(run, candidate)
        if exact is not None and source_digest(Path(candidate["path"])) != exact:
            raise ValueError("the checks changed files in the candidate's checkout (a submodule they filled in or emptied?), "
                             "so what they read is not what the commit holds; prepare and test a new candidate")
        candidate["verified_by"] = verifier
        if waived:
            candidate["waived"] = waived
        save_candidate(run, candidate)
    if timing:
        print(f"Verification final source validation: {time.monotonic() - started_validation:.2f}s")
    if waived:
        print("Failing on the base in the same way, and so waived; name each in your report: " + "; ".join(waived))
    if candidate.get("allowed"):
        print("Allowed by the coordinator at prepare, past the diff guards; name each in your report: "
              + "; ".join(candidate["allowed"]))
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


def landing_guards(found):
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


def ref_state(root):
    parent = git(root, "rev-parse", "-q", "--verify", "HEAD", optional=True)
    branch = git(root, "symbolic-ref", "--quiet", "HEAD", optional=True)
    return ((parent or b"").decode().strip(), os.fsdecode(branch).rstrip("\n") if branch else "HEAD")


def index_snapshot(path):
    try:
        with path.open("rb") as index:
            return index.read(), os.fstat(index.fileno()).st_mtime_ns
    except FileNotFoundError:
        return None


def index_digest(snapshot):
    return hashlib.sha256(snapshot[0]).hexdigest() if snapshot is not None else None


def publish_index(root, live, original, private, parent, ref, revision, recovery=None):
    # Respect Git's index lock. A concurrently staged change takes precedence over publishing our staging area.
    lock = live.with_name(live.name + ".lock")
    try:
        locked = lock.open("xb")
    except FileExistsError:
        raise ValueError("the Git index is locked by another operation; retry after it finishes") from None
    published = False
    try:
        with locked:
            locked.write(Path(private).read_bytes())
        if index_snapshot(live) != original or ref_state(root) != (parent, ref):
            raise ValueError("the Git index or HEAD changed during the commit; inspect it and retry")
        if revision:
            atomic_write(recovery, json.dumps({"revision": revision, "parent": parent, "ref": ref, "index": index_digest(original)}))
            args = ("--no-deref",) if ref == "HEAD" else ()
            try:
                git(root, "update-ref", "-m", "commit: verified Swarm candidate", *args,
                    ref, revision, parent or "0" * len(revision))
            except ValueError:
                recovery.unlink(missing_ok=True)
                raise
        try:
            os.replace(lock, live)
        except OSError as error:
            if revision:
                raise ValueError(f"commit {revision} landed on {ref}, but the Git index could not be updated: {error}") from error
            raise
        published = True
        if recovery is not None:
            recovery.unlink(missing_ok=True)
    finally:
        if not published:
            lock.unlink(missing_ok=True)


def commit_hook(root, name, *args, index=None):
    # rev-parse respects core.hooksPath and linked worktrees, including on Git versions without `git hook run`.
    path = git(root, "rev-parse", "--path-format=absolute", "--git-path", f"hooks/{name}")
    hook = Path(os.fsdecode(path.rstrip(b"\n")))
    if not hook.is_file() or not os.access(hook, os.X_OK):
        return
    env = clean_env()
    if index is not None:
        env["GIT_INDEX_FILE"] = index
        env["GIT_EDITOR"] = ":"
    command = [str(hook), *args]
    try:
        result = subprocess.run(command, cwd=root, capture_output=True, env=env)
    except OSError as error:
        if error.errno != errno.ENOEXEC:
            raise
        result = subprocess.run(["/bin/sh", *command], cwd=root, capture_output=True, env=env)
    if result.returncode:
        detail = os.fsdecode(result.stderr or result.stdout).strip()
        raise ValueError(f"{name} hook exited {result.returncode}" + (f": {detail}" if detail else ""))


def pending_commit_hooks(root, private, scratch, message):
    msg = Path(scratch) / "COMMIT_EDITMSG"
    msg.write_bytes(git(root, "stripspace", data=os.fsencode(message + "\n")))
    commit_hook(root, "pre-commit", index=private)
    commit_hook(root, "prepare-commit-msg", str(msg), "message", index=private)
    commit_hook(root, "commit-msg", str(msg), index=private)
    msg.write_bytes(git(root, "stripspace", data=msg.read_bytes()))
    if not msg.stat().st_size:
        raise ValueError("the commit message is empty")
    return msg


def recovery_file(run, identifier):
    return run / f"commit-recovery-{identifier}.json"


def recover_index(run, project, identifier):
    with board_lock(run), tempfile.TemporaryDirectory() as scratch:
        candidate_for(run, project, identifier)
        recovery = recovery_file(run, identifier)
        if not recovery.is_file():
            raise ValueError("there is no pending index recovery for this candidate")
        record = json.loads(recovery.read_text(encoding="utf-8"))
        found = repository(project)
        if found is None:
            raise ValueError("the project is no longer a Git repository")
        root, _ = found
        revision, ref = record["revision"], record["ref"]
        current = ref_state(root)
        if current == (record["parent"], ref):
            recovery.unlink()
            print("HEAD is at the original parent. No index recovery was needed.")
            return
        if current != (revision, ref):
            raise ValueError("HEAD moved since publication; inspect the index before changing it")
        live = Path(os.fsdecode(git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").rstrip(b"\n")))
        original = index_snapshot(live)
        private = os.path.join(scratch, "index")
        if index_digest(original) != record["index"]:
            # Publication may already have installed the index before the process stopped.
            if git(root, "diff", "--cached", "--quiet", revision, optional=True) is None:
                raise ValueError("the index changed since publication; inspect the staged changes before changing it")
            recovery.unlink()
        else:
            git(root, "-c", "core.splitIndex=false", "read-tree", revision, index=private)
            publish_index(root, live, original, private, revision, ref, None, recovery)
    print(f"RECOVERED INDEX {revision}")


def commit(run, project, identifier, message):
    """Land the immutable verified tree, and publish its index only after the ref update succeeds."""
    with tempfile.TemporaryDirectory() as scratch:
        with board_lock(run):
            candidate = candidate_for(run, project, identifier)
            if candidate["mode"] == "isolated":
                raise ValueError("an isolated candidate's commits are in the checkout once it is accepted: there is nothing to commit")
            if not candidate.get("accepted"):
                raise ValueError("this candidate is not accepted: run `accept` first")
            recovery = recovery_file(run, identifier)
            if recovery.exists():
                raise ValueError(f"a commit may already have landed; run `recover-index {identifier}` for this run")
            found = repository(project)
            if found is None:
                raise ValueError("the project is not a Git repository, so there is nothing to commit")
            root = found[0]
            parent, ref = ref_state(root)
            for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"):
                path = git(root, "rev-parse", "--path-format=absolute", "--git-path", marker)
                if Path(os.fsdecode(path.rstrip(b"\n"))).exists():
                    raise ValueError("finish the Git operation already in progress before committing")
            check_current(run, candidate, allow_closed=True)
            landing_guards(found)
            skip = not_source(found)
            live = Path(os.fsdecode(git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").rstrip(b"\n")))
            original = index_snapshot(live)
            private = os.path.join(scratch, "index")
            if original is not None:
                data, mtime = original
                Path(private).write_bytes(data)
                # Git uses this timestamp to recheck files written within the index's timestamp resolution.
                os.utime(private, ns=(mtime, mtime))
            git(root, "-c", "core.splitIndex=false", "add", "-A", "--", *stage_paths(skip), index=private)
            tree = git(root, "write-tree", index=private).decode().strip()
            names = [name for name in git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", index=private)
                     .split(b"\0") if name]
            modes = dict((entry.partition(b"\t")[2], entry.split()[0]) for entry in
                         git(root, "ls-files", "-s", "-z", index=private).split(b"\0") if entry)
            unread = [shown(os.fsdecode(name)) for name in names if in_worktree(name, skip)]
            if unread:
                raise ValueError("the commit would hold %s, which is Swarm's run data or a linked worktree and no source"
                                 % ", ".join(unread[:5]))
            # What Git stores is the file as its filters and line-ending rules convert it: a file a fresh checkout would
            # not bring back as the checks read it was never tested in the form the commit holds.
            checkout = Path(scratch) / "checkout"
            checkout.mkdir()
            git(root, "checkout-index", "--all", f"--prefix={checkout}/", index=private)
            turned = []
            for name, mode in modes.items():
                if in_worktree(name, skip) or mode not in (b"100644", b"100755"):
                    continue
                path = os.fsdecode(name)
                source, restored = root / path, checkout / path
                try:
                    same = filecmp.cmp(source, restored, shallow=False)
                except FileNotFoundError:
                    # A sparse checkout omits these paths from both the source and the private checkout.
                    same = not source.exists() and not restored.exists()
                if not same:
                    turned.append(shown(path))
            if turned:
                raise ValueError("a fresh checkout of the commit would not bring back %s as the checks read it (a line-ending "
                                 "or filter rule converts it one way only). Fix the file or its .gitattributes rule, then "
                                 "prepare and test a new candidate" % ", ".join(turned[:5]))
            left = [shown(os.fsdecode(path)) for code, path in pending_changes(project, codes=True, git_index=private)
                    if code[1:] != b" "]
            if left:
                raise ValueError("staging left %s apart from the index, so the commit would not hold the verified files; "
                                 "prepare and test a new candidate" % ", ".join(left[:5]))
            if source_digest(project) != candidate["digest"]:
                raise ValueError("source files changed after acceptance")
            if tree == (git(root, "rev-parse", "-q", "--verify", "HEAD^{tree}", optional=True) or b"").decode().strip():
                publish_index(root, live, original, private, parent, ref, None)
                print("Nothing to commit: HEAD already holds the verified files")
                return
        # Release the board lock for hooks and signing, which can block on a build or user input.
        msg = pending_commit_hooks(root, private, scratch, message)
        if git(root, "write-tree", index=private).decode().strip() != tree:
            raise ValueError("a commit hook changed the verified Git tree; no commit was made")
        signing = git(root, "config", "--bool", "--get", "commit.gpgsign", optional=True) == b"true\n"
        revision = git(root, "commit-tree", tree, *(("-p", parent) if parent else ()),
                       *(("-S",) if signing else ()), "-F", str(msg)).decode().strip()
        # The hooks ran outside the board lock. Check the acceptance and source again before the ref update.
        with board_lock(run):
            if candidate_for(run, project, identifier) != candidate:
                raise ValueError("the accepted candidate changed during the commit")
            check_current(run, candidate, allow_closed=True)
            try:
                publish_index(root, live, original, private, parent, ref, revision, recovery)
            except ValueError as error:
                if not recovery.is_file():
                    raise
                command = shlex.join([sys.executable, os.path.abspath(__file__), str(run), str(project),
                                      "recover-index", identifier])
                raise ValueError(f"{error}\nRecover the index with: {command}") from error
        print(f"COMMITTED {identifier} {revision}", flush=True)
        try:
            commit_hook(root, "post-commit")
        except (OSError, ValueError) as error:
            print(f"Post-commit hook failed: {error}", file=sys.stderr)


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
                landing_guards(found)
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
            landing_guards(found)
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
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("run", type=Path)
    parser.add_argument("project", type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    prep = actions.add_parser("prepare", allow_abbrev=False)
    prep.add_argument("mode", choices=("shared", "isolated"))
    checks = prep.add_mutually_exclusive_group(required=True)
    checks.add_argument("--check", action="append")
    checks.add_argument("--no-checks", action="store_true")
    prep.add_argument("--base", help="build an isolated candidate on this ref instead of the checkout's HEAD")
    prep.add_argument("--allow", action="append", metavar="KIND:TARGET",
                      help="let one case past the diff guards: rewrite:<path>, reformat:<path>, newline:<path> or removed:<symbol>")
    prep.add_argument("--baseline-diff", action="store_true",
                      help="waive a check that fails on the candidate's base with the same output (isolated only)")
    prep.add_argument("--members", help="a partial candidate of these workers, comma-separated: tested, never accepted")
    test = actions.add_parser("test", allow_abbrev=False)
    test.add_argument("candidate")
    test.add_argument("verifier")
    test.add_argument("--timeout", help="per-check timeout in seconds (overrides SWARM_VERIFY_TIMEOUT)")
    actions.add_parser("accept", allow_abbrev=False).add_argument("candidate")
    landed = actions.add_parser("commit", allow_abbrev=False)
    landed.add_argument("candidate")
    landed.add_argument("-m", "--message", required=True)
    actions.add_parser("recover-index", allow_abbrev=False).add_argument("candidate")
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
            if args.baseline_diff and (args.mode != "isolated" or args.no_checks):
                # A shared candidate runs in the user's checkout, with dependencies no fresh checkout of its base has.
                raise ValueError("--baseline-diff is for an isolated candidate with checks")
            prepare(run, project, args.mode, None if args.no_checks else args.check, args.base, subset, args.baseline_diff,
                    allowances(args.allow))
        elif args.action == "test":
            test_candidate(run, project, args.candidate, args.verifier, args.timeout)
        elif args.action == "commit":
            if not args.message.strip():
                raise ValueError("the commit needs a message")
            commit(run, project, args.candidate, args.message)
        elif args.action == "recover-index":
            recover_index(run, project, args.candidate)
        else:
            accept(run, project, args.candidate)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"verification: {error}")

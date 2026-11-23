#!/usr/bin/env python3
"""Run the checks a change needs, and only those.

    python3 tests/check.py                 what the uncommitted changes touch
    python3 tests/check.py --base REF      what changed since REF (a branch, a commit), uncommitted work included
    python3 tests/check.py --all           everything: before a version bump
    python3 tests/check.py --only py|ts    one side of the selection
    python3 tests/check.py --list          print what would run, and run nothing

Python tests run one test per process, several at once: each spawns board.py or verify.py many times, so the suite
is bound by process starts, not by any one test. A test that fails under that load is run once more on its own
before it counts as failed. An edit inside one test of a test file runs that test alone.
"""
import ast
import glob
import os
import re
import shutil
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARITY = "tests.test_board.BoardRegressions.test_parity_vectors_match_the_board"
# The first rule a path matches names its checks. `board` and `verify` are the Python test modules; the rest are
# commands. Both engine scripts run both modules: verify.py imports board.py, and board.py's sync and stale checks
# import verify.py.
RULES = (
    (r"tests/check\.py$", ()),
    (r"tests/engine\.py$", ("board", "verify")),
    (r"tests/test_board\.py$", ("board",)),
    (r"tests/test_verify\.py$", ("verify",)),
    (r"tests/parity\.json$", ("parity", "units")),
    (r"skills/swarm/scripts/.*\.py$", ("board", "verify")),
    (r"hooks/(?:units\.test\.ts|graph\.test\.tsx)$", ("types", "units")),
    (r"hooks/register\.test\.tsx$", ("types", "host")),
    (r"(?:hooks|types)/|tsconfig\.json$|bunfig\.toml$|\.claude-plugin/", ("types", "units", "host", "validate")),
    (r"", ("validate",)),  # skills, agents, the README: text the plugin loads
)
ORDER = ("types", "units", "validate", "host", "parity", "board", "verify")
SIDE = {"types": "ts", "units": "ts", "validate": "ts", "host": "ts", "parity": "py", "board": "py", "verify": "py"}


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def changed(base):
    """Paths under the plugin that differ from BASE (HEAD when none), untracked files included."""
    names = git("diff", "--name-only", "--relative", base or "HEAD", "--", ".").split("\n")
    names += git("ls-files", "--others", "--exclude-standard", "--", ".").split("\n")
    return sorted({name for name in names if name})


def touched_tests(path, base):
    """The tests of a Python test file whose own lines changed, or None when a line outside any test did (a helper,
    an import): then the whole module runs."""
    lines = set()
    for start, count in re.findall(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", git("diff", "-U0", base or "HEAD", "--", path), re.M):
        lines.update(range(int(start), int(start) + int(count or 1)))  # a pure deletion (count 0) names no line
    if not lines:
        return None  # an untracked file, or deletions only
    module = "tests." + os.path.basename(path)[:-3]
    source = open(os.path.join(ROOT, path), encoding="utf-8").read()
    text = source.split("\n")
    lines = {line for line in lines if line <= len(text) and text[line - 1].strip()}  # the blank line around a new test is nobody's
    spans = [(node.lineno - len(node.decorator_list), node.end_lineno, "%s.%s.%s" % (module, cls.name, node.name))
             for cls in ast.parse(source).body if isinstance(cls, ast.ClassDef)
             for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test")]
    found = set()
    if not lines:
        return None
    for line in lines:
        owner = next((name for first, last, name in spans if first <= line <= last), None)
        if owner is None:
            return None
        found.add(owner)
    return sorted(found)


def test_ids(module):
    ids = []

    def walk(suite):
        for item in suite:
            walk(item) if isinstance(item, unittest.TestSuite) else ids.append(item.id())
    sys.path.insert(0, ROOT)
    walk(unittest.defaultTestLoader.loadTestsFromName("tests." + module))
    return ids


def claude():
    """The claude binary: on PATH, or the newest copy the desktop app keeps."""
    found = shutil.which("claude")
    if found:
        return found
    copies = glob.glob(os.path.expanduser("~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"))
    return max(copies, key=os.path.getmtime) if copies else None


def command(args):
    started = time.time()
    done = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    return done.returncode == 0, done.stdout + done.stderr, time.time() - started


def python_tests(ids):
    """Every id in a process of its own, on all cores but two (CHECK_JOBS sets another count); a failure is tried
    once more alone. Measured on ten cores: eight workers finish in the time of the longest single test."""
    def one(name):
        return (name, *command([sys.executable, "-B", "-m", "unittest", name]))
    started = time.time()
    with ThreadPoolExecutor(max_workers=int(os.environ.get("CHECK_JOBS") or max(2, (os.cpu_count() or 4) - 2))) as pool:
        results = list(pool.map(one, ids))
    failed = [one(name) for name, passed, _, _ in results if not passed]
    retried = [name for name, passed, _, _ in failed if passed]
    failed = [(name, output) for name, passed, output, _ in failed if not passed]
    slowest = sorted(results, key=lambda result: -result[3])[:3]
    note = "%d tests, slowest %s" % (len(ids), ", ".join("%s %.0fs" % (name.rsplit(".", 1)[1], took) for name, _, _, took in slowest))
    if retried:
        note += "; passed only when run alone: " + ", ".join(name.rsplit(".", 1)[1] for name in retried)
    return not failed, "\n".join(output for _, output in failed), time.time() - started, note


def main(argv):
    flags = {"--all", "--list"}
    base = argv[argv.index("--base") + 1] if "--base" in argv and argv.index("--base") + 1 < len(argv) else None
    only = argv[argv.index("--only") + 1] if "--only" in argv and argv.index("--only") + 1 < len(argv) else None
    rest = [arg for i, arg in enumerate(argv) if arg not in flags and arg not in ("--base", "--only") and (i == 0 or argv[i - 1] not in ("--base", "--only"))]
    if rest or ("--base" in argv and base is None) or only not in (None, "py", "ts"):
        sys.exit(__doc__)
    picked, narrowed, whole = set(), {}, set()
    if "--all" in argv:
        picked = set(ORDER) - {"parity"}
    else:
        paths = changed(base)
        if not paths:
            sys.exit("nothing changed since %s. Use --all to run everything" % (base or "HEAD"))
        print("changed: " + ", ".join(paths))
        for path in paths:
            checks = next(checks for pattern, checks in RULES if re.match(pattern, path))
            picked.update(checks)
            # A test file's own edit may name single tests; any other reason to run its module runs all of it.
            named = touched_tests(path, base) if checks in (("board",), ("verify",)) and os.path.exists(os.path.join(ROOT, path)) else None
            if named is None:
                whole.update(check for check in checks if check in ("board", "verify"))
            else:
                narrowed[checks[0]] = named
    if picked & {"board"}:
        picked.discard("parity")  # the module holds it
    picked = [check for check in ORDER if check in picked and only in (None, SIDE[check])]
    binary = claude() if {"host", "validate"} & set(picked) else None
    ids = {check: test_ids("test_" + check) if check in whole or "--all" in argv else narrowed[check] for check in picked if check in ("board", "verify")}
    if "--list" in argv:
        for check in picked:
            print(check + (": %d tests" % len(ids[check]) if check in ids else ""))
        return 0
    failures = 0
    # Both engine modules share one pool, so their long tests overlap.
    engine = [check for check in picked if check in ids]
    for check in [check for check in picked if check not in ids] + (["engine"] if engine else []):
        note = ""
        if check == "engine":
            passed, output, took, note = python_tests([name for module in engine for name in ids[module]])
            note = "%s: %s" % (" and ".join(engine), note)
        elif check == "parity":
            passed, output, took = command([sys.executable, "-B", "-m", "unittest", PARITY])
        elif check == "types":
            passed, output, took = command(["bunx", "tsc", "--noEmit"])
        elif check == "units":
            passed, output, took = command(["bun", "test", "hooks/units.test.ts", "hooks/graph.test.tsx"])
        elif binary is None:
            passed, output, took = False, "claude was not found on PATH or in the desktop app: this check did NOT run", 0.0
        elif check == "host":
            passed, output, took = command([binary, "plugin", "test", "."])
            output = "\n".join(line for line in output.split("\n") if not line.startswith("(pass)"))
        else:
            passed, output, took = command([binary, "plugin", "validate", "."])
            passed = passed and "not type-checked" not in output.lower()
        failures += not passed
        print("%s %-8s %5.1fs%s" % ("ok  " if passed else "FAIL", check, took, "  " + note if note else ""), flush=True)
        if not passed:
            print(output.strip()[-6000:], flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

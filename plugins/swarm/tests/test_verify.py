#!/usr/bin/env python3
"""Exercise the verification gate against temporary Git repositories."""
from pathlib import Path
import fcntl
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent.parent / "skills" / "swarm" / "scripts"


def run(*args, cwd=None, text=None, ok=True, env=None):
    result = subprocess.run(args, cwd=cwd, input=text, text=True, capture_output=True, env=env)
    assert (result.returncode == 0) == ok, (args, result.stdout, result.stderr)
    return result.stdout.strip()


def scenario():
    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp)
        def git(*args, cwd=project):
            return run("git", *args, cwd=cwd)
        git("init", "-b", "main")
        git("config", "user.name", "Swarm Test")
        git("config", "user.email", "swarm@example.invalid")
        git("config", "commit.gpgsign", "false")
        (project / "left").write_text("0")
        (project / "right").write_text("0")
        (project / "package").mkdir()
        (project / "package" / "flag").write_text("no")
        git("add", ".")
        git("commit", "-m", "Initial")
        base = git("rev-parse", "HEAD")
        board = run(sys.executable, SCRIPTS / "board.py", project / ".swarm" / "demo", "init", "Test")

        def post(*args, text=None, ok=True):
            return run(sys.executable, SCRIPTS / "board.py", board, *args, text=text, ok=ok)

        def gate(*args, ok=True):
            return run(sys.executable, SCRIPTS / "verify.py", board, project, *args, ok=ok)

        def commit_change(branch, filename, content, start):
            git("switch", "-C", branch, start)
            (project / filename).write_text(content)
            git("add", "--", filename)
            git("commit", "-m", f"Change {filename}")
            return git("rev-parse", "HEAD")

        for name in ["left", "right"]:
            post("member", name)
        post("member", "verifier", "role=verifier")
        check = "test \"$(cat left)$(cat right)\" != 11"
        left = commit_change("left-work", "left", "1", base)
        run("/bin/sh", "-c", check, cwd=project)
        right = commit_change("right-work", "right", "1", base)
        run("/bin/sh", "-c", check, cwd=project)
        git("switch", "main")
        post("ready", "left", left, text="left is ready")
        gate("prepare", "isolated", "--check", check, ok=False)
        post("ready", "right", right, text="right is ready")
        bad = json.loads(gate("prepare", "isolated", "--check", check))
        gate("test", bad["candidate"], "verifier", ok=False)
        gate("accept", bad["candidate"], ok=False)
        assert git("rev-parse", "HEAD") == base

        fixed = commit_change("right-work", "right", "2", right)
        git("switch", "main")
        post("ready", "right", fixed, text="right changed to 2")
        good = json.loads(gate("prepare", "isolated", "--check", check))
        # The integration merges are the repository's own commits: its identity, never one of Swarm's.
        assert git("log", "-1", "--format=%an <%ae>", good["commit"]) == "Swarm Test <swarm@example.invalid>"
        # the board takes the line the checks printed, here naming the candidate's commit, and no other
        line = gate("test", good["candidate"], "verifier").splitlines()[-1]
        assert line == "VERIFIED %s %s" % (good["candidate"], good["commit"]) and len(good["commit"]) == 40
        post("post", "verifier", "@coordinator VERIFIED %s %s" % (good["candidate"], good["digest"]), ok=False)
        post("post", "verifier", "@coordinator " + line)
        git("switch", "-c", "same-head")
        gate("accept", good["candidate"], ok=False)
        assert git("rev-parse", "HEAD") == base
        git("switch", "main")
        (project / "unrelated").write_text("keep me")
        gate("accept", good["candidate"], ok=False)
        assert (project / "unrelated").read_text() == "keep me"
        assert git("rev-parse", "HEAD") == base
        (project / "unrelated").unlink()
        # a folder whose name merely ends in ".swarm" is the user's own: acceptance refuses before it moves anything
        lookalike = project / "docs" / "archive .swarm"
        lookalike.mkdir(parents=True)
        (lookalike / "note").write_text("mine")
        gate("accept", good["candidate"], ok=False)
        assert git("rev-parse", "HEAD") == base and (lookalike / "note").read_text() == "mine"
        (lookalike / "note").unlink()
        lookalike.rmdir()
        (project / "docs").rmdir()
        # so is a .swarm folder that is not the project's own: an untracked file in it is a pending change
        foreign = project / "docs" / ".swarm" / "note"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("mine")
        gate("accept", good["candidate"], ok=False)
        assert git("rev-parse", "HEAD") == base and foreign.read_text() == "mine"
        foreign.unlink()
        foreign.parent.rmdir()
        (project / "docs").rmdir()
        gate("accept", good["candidate"])
        gate("accept", good["candidate"])
        assert git("rev-parse", "HEAD") == good["commit"]
        # a retest that cannot run (the candidate's checkout is gone) leaves the record of the pass alone
        gate("test", good["candidate"], "verifier", ok=False)
        gate("accept", good["candidate"])
        # an accepted pass is still rechecked when its line is posted
        post("post", "verifier", "@coordinator " + line)
        (project / "left").write_text("9")
        assert "void" in subprocess.run([sys.executable, SCRIPTS / "board.py", board, "post", "verifier", "@coordinator " + line],
                                        capture_output=True, text=True).stderr
        git("checkout", "--", "left")
        post("post", "verifier", "@coordinator " + line)

        # a .swarm folder that is not the project's own is source: it is fingerprinted and blocks acceptance
        fixture = project / "fixtures" / ".swarm" / "sample"
        fixture.parent.mkdir(parents=True)
        fixture.write_text("fixture")
        gate("accept", good["candidate"], ok=False)
        fixture.unlink()
        fixture.parent.rmdir()
        fixture.parent.parent.rmdir()
        gate("accept", good["candidate"])

        package = project / "package"
        nested_run = run(sys.executable, SCRIPTS / "board.py", package / ".swarm" / "demo", "init", "Nested project")
        nested_change = commit_change("nested-work", "package/flag", "yes", good["commit"])
        git("switch", "main")
        run(sys.executable, SCRIPTS / "board.py", nested_run, "member", "worker")
        run(sys.executable, SCRIPTS / "board.py", nested_run, "member", "verifier", "role=verifier")
        run(sys.executable, SCRIPTS / "board.py", nested_run, "ready", "worker", nested_change, text="flag changed")
        nested_gate = [sys.executable, SCRIPTS / "verify.py", nested_run, package]
        nested = json.loads(run(*nested_gate, "prepare", "isolated", "--check", 'test "$(cat flag)" = yes'))
        assert Path(nested["path"]).name == "package"
        run(*nested_gate, "test", nested["candidate"], "verifier")
        run(*nested_gate, "accept", nested["candidate"])
        assert (package / "flag").read_text() == "yes"

        post("ready", "left", text="left is ready in shared workspace")
        post("ready", "right", text="right is ready in shared workspace")
        (project / "new-input").write_text("before")
        shared = json.loads(gate("prepare", "shared", "--check", check))
        gate("test", shared["candidate"], "verifier")
        (project / "new-input").write_text("after")
        gate("accept", shared["candidate"], ok=False)
        shared = json.loads(gate("prepare", "shared", "--check", check))
        # a shared candidate has no commit: its line names the source digest
        line = gate("test", shared["candidate"], "verifier").splitlines()[-1]
        (project / "new-input").write_text("changed after the pass")  # the pass no longer describes the sources
        assert "void" in subprocess.run([sys.executable, SCRIPTS / "board.py", board, "post", "verifier", "@coordinator " + line],
                                        capture_output=True, text=True).stderr
        (project / "new-input").write_text("after")
        post("post", "verifier", "@coordinator " + line)
        post("revise", "left", "another pass")
        assert "[stale]" in post("attention")  # a change reported after VERIFIED is flagged with the VERIFIED post
        gate("accept", shared["candidate"], ok=False)
        post("ready", "left", text="ready again")
        mutating = json.loads(gate("prepare", "shared", "--check", "echo changed > new-input"))
        gate("test", mutating["candidate"], "verifier", ok=False)
        gate("accept", mutating["candidate"], ok=False)

        post("member", "investigator", "profile=investigator", "writes=0")
        finding = post("ready", "investigator", text="The combined behavior is understood.").split()[1].lstrip("#")
        gate("prepare", "shared", "--check", check, ok=False)
        post("confirm", "investigator", finding)
        reviewed = json.loads(gate("prepare", "shared", "--check", check))
        gate("test", reviewed["candidate"], "verifier")
        # a consultant asked mid-verification neither blocks nor voids the candidate
        post("member", "advisor", "profile=architect", "writes=0", "consult=1")
        gate("accept", reviewed["candidate"])
        gate("prepare", "shared", "--check", "  ", ok=False)
        # A separate verification process owns the checkout while testing or accepting it.
        with (project / ".git" / ".verification.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            gate("prepare", "shared", "--check", check, ok=False)
            gate("accept", reviewed["candidate"], ok=False)
        # Board commands can run while the checks do. A reviewer retired mid-check cannot supply a pass.
        retire = shlex.join([sys.executable, str(SCRIPTS / "board.py"), board, "member", "verifier", "killed=1"])
        retired = json.loads(gate("prepare", "shared", "--check", retire))
        gate("test", retired["candidate"], "verifier", ok=False)
        gate("accept", retired["candidate"], ok=False)


    # A project whose own .swarm/.gitignore does not ignore run data can still be verified and accepted.
    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp).resolve()
        def git(*args):
            return run("git", "-C", project, *args)
        git("init", "-b", "main")
        git("config", "user.email", "swarm@example.invalid")
        git("config", "user.name", "Swarm test")
        git("config", "commit.gpgsign", "false")
        (project / "value").write_text("0")
        (project / ".swarm").mkdir()
        (project / ".swarm" / ".gitignore").write_text("# the project's own notes\n")
        git("add", "value")
        git("commit", "-m", "Initial")
        started = subprocess.run([sys.executable, SCRIPTS / "board.py", project / ".swarm" / "demo", "init", "Kept"],
                                 capture_output=True, text=True)
        board = started.stdout.strip()
        assert "does not ignore everything" in started.stderr
        assert (project / ".swarm" / ".gitignore").read_text() == "# the project's own notes\n"
        for args in (("member", "w"), ("member", "verifier", "role=verifier")):
            run(sys.executable, SCRIPTS / "board.py", board, *args)
        gate = [sys.executable, SCRIPTS / "verify.py", board, project]
        for mode in ("shared", "isolated"):
            git("switch", "-C", "work", "main")
            (project / "value").write_text(mode)
            git("commit", "-am", "Change value")
            change = git("rev-parse", "HEAD")
            if mode == "isolated":
                git("switch", "main")
            run(sys.executable, SCRIPTS / "board.py", board, "ready", "w", *([change] if mode == "isolated" else []), text="done")
            candidate = json.loads(run(*gate, "prepare", mode, "--check", "test -s value"))
            line = run(*gate, "test", candidate["candidate"], "verifier").splitlines()[-1]
            run(sys.executable, SCRIPTS / "board.py", board, "post", "verifier", "@coordinator " + line)
            run(*gate, "accept", candidate["candidate"])
            git("switch", "main")
            git("merge", "--ff-only", "work")

    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp).resolve()
        (project / "input").write_text("data")
        board = run(sys.executable, SCRIPTS / "board.py", project / ".swarm" / "demo", "init", "No Git")
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, project]
        run(*post, "member", "worker")
        run(*post, "member", "verifier", "role=verifier")
        run(*post, "ready", "worker", text="done")
        env = dict(os.environ, PATH="")
        candidate = json.loads(run(*gate, "prepare", "shared", "--check", "test -s input", env=env))
        run(*gate, "test", candidate["candidate"], "verifier", env=env)
        run(*gate, "accept", candidate["candidate"], env=env)

    # A submodule that is not checked out (as in a fresh worktree) is fingerprinted by its recorded commit, and a
    # Git failure other than "not a repository" is an error, never a silent fall back to hashing every file.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SCRIPTS))
    import verify  # noqa: E402

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)
        def git(*args):
            return run("git", *args, cwd=repo)
        git("init", "-b", "main")
        git("config", "user.name", "Swarm Test")
        git("config", "user.email", "swarm@example.invalid")
        git("config", "commit.gpgsign", "false")
        (repo / "file").write_text("1")
        git("add", ".")
        git("commit", "-m", "Initial")
        head = git("rev-parse", "HEAD")
        git("update-index", "--add", "--cacheinfo", "160000,%s,vendor/lib" % head)
        (repo / "vendor" / "lib").mkdir(parents=True)
        first = verify.source_digest(repo)
        git("update-index", "--cacheinfo", "160000,%s,vendor/lib" % ("1" * 40))
        assert verify.source_digest(repo) != first  # the recorded commit is part of the fingerprint

        real = verify.git
        try:
            verify.git = lambda *a, **k: (_ for _ in ()).throw(ValueError("fatal: detected dubious ownership in repository"))
            try:
                verify.source_digest(repo)
                raise AssertionError("a Git failure was treated as no repository")
            except ValueError as error:
                assert "dubious ownership" in str(error)
            verify.git = lambda *a, **k: (_ for _ in ()).throw(ValueError("fatal: not a git repository"))
            assert verify.toplevel(repo) is None
        finally:
            verify.git = real


class VerifyScenario(unittest.TestCase):
    """One end-to-end scenario against temporary run folders, so `python3 -m unittest discover` finds and runs it."""

    def test_scenario(self):
        scenario()


if __name__ == "__main__":
    scenario()
    print("ok")

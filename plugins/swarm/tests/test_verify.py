#!/usr/bin/env python3
"""Exercise the verification gate against temporary Git repositories."""
import sys

sys.dont_write_bytecode = True  # a test run leaves no __pycache__ in the plugin folder
from pathlib import Path
import contextlib
import fcntl
import io
import json
import os
import re
import shlex
import signal
import subprocess
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parent.parent / "skills" / "swarm" / "scripts"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402

# A fixture's Git commands reach the temporary repository, whatever repository a hook that runs the tests is in.
NO_GIT_ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
# A report after a NOT PASSED answers each finding the board numbered.
ANSWERS = "\n".join("F%d: fixed — the change holds it" % n for n in range(1, 6))


def run(*args, cwd=None, text=None, ok=True, env=None):
    if cwd is None and env is None and len(args) > 1 and args[0] == sys.executable and str(args[1]) == engine.BOARD:
        code, out, err = engine.board(*args[2:], stdin=text)  # a board command: no process of its own (tests/engine.py)
        assert (code == 0) == ok, (args, out, err)
        return out.strip()
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
        # A candidate can be built on a ref other than the checkout's HEAD. A member that did not branch from the
        # base is named, and such a candidate is not fast-forwarded into a checkout that sits elsewhere.
        gate("prepare", "shared", "--check", check, "--base", "main", ok=False)
        onto = subprocess.run([sys.executable, SCRIPTS / "verify.py", board, project, "prepare", "isolated", "--check", "true",
                               "--base", "left-work"], capture_output=True, text=True)
        assert onto.returncode == 0, onto.stderr
        assert "@right did not branch from the candidate's base" in onto.stderr and "@left" not in onto.stderr
        elsewhere = json.loads(onto.stdout)
        post("post", "verifier", "@coordinator " + gate("test", elsewhere["candidate"], "verifier").splitlines()[-1])
        refused = subprocess.run([sys.executable, SCRIPTS / "verify.py", board, project, "accept", elsewhere["candidate"]],
                                 capture_output=True, text=True)
        assert refused.returncode != 0 and "was built on left-work, not on the checkout" in refused.stderr, refused.stderr
        assert git("rev-parse", "HEAD") == base
        # ... and it is accepted from that base, whatever branch the checkout was on when it was prepared
        git("switch", "-q", "--detach", "left-work")
        gate("accept", elsewhere["candidate"])
        assert git("rev-parse", "HEAD") == elsewhere["commit"]
        git("switch", "-q", "main")
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
        line = run(*nested_gate, "test", nested["candidate"], "verifier").splitlines()[-1]
        run(sys.executable, SCRIPTS / "board.py", nested_run, "post", "verifier", "@coordinator " + line)
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
        line = gate("test", reviewed["candidate"], "verifier").splitlines()[-1]
        post("post", "verifier", "@coordinator " + line)
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
        line = run(*gate, "test", candidate["candidate"], "verifier", env=env).splitlines()[-1]
        run(*post, "post", "verifier", "@coordinator " + line, env=env)
        run(*gate, "accept", candidate["candidate"], env=env)
        # A run with nothing a command could test says so. An empty list it did not ask for is still refused.
        run(*gate, "prepare", "shared", ok=False)
        run(*gate, "prepare", "shared", "--check", "true", "--no-checks", ok=False)
        assert "only writers are designers" in subprocess.run([*gate, "prepare", "shared", "--no-checks"], capture_output=True, text=True, env=env).stderr
        run(*post, "member", "worker", "profile=designer")
        run(*gate, "prepare", "shared", "--no-checks", env=env, ok=False)
        run(*post, "ready", "worker", text="design checked")
        bare = json.loads(run(*gate, "prepare", "shared", "--no-checks", env=env))
        assert run(*gate, "test", bare["candidate"], "verifier", env=env) == "VERIFIED %s %s" % (bare["candidate"], bare["digest"])
        run(*post, "post", "verifier", "@coordinator VERIFIED %s %s" % (bare["candidate"], bare["digest"]), env=env)
        record = Path(board) / "verification.json"
        passed = record.read_text()
        record.write_text(json.dumps(dict(json.loads(passed), no_checks=False)))
        run(*gate, "accept", bare["candidate"], ok=False, env=env)
        record.write_text(passed)
        run(*gate, "accept", bare["candidate"], env=env)

    # A submodule that is not checked out (as in a fresh worktree) is fingerprinted by its recorded commit, and a
    # Git failure other than "not a repository" is an error, never a silent fall back to hashing every file.
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

        # a tracked file replaced by a folder is a folder, not a submodule named by the old blob
        (repo / "file").unlink()
        (repo / "file").mkdir()
        empty = verify.source_digest(repo)
        git("update-index", "--cacheinfo", "100644,%s,file" % run("git", "hash-object", "-w", "--stdin", cwd=repo, text="2"))
        assert verify.source_digest(repo) == empty
        (repo / "file" / "inner").write_text("1")
        assert verify.source_digest(repo) != empty

    # A checked-out submodule: the integration worktree has it absent, the user's checkout has it clean at the
    # recorded commit, and both must fingerprint alike or no isolated candidate could ever be accepted.
    with tempfile.TemporaryDirectory() as temp:
        library, project = Path(temp).resolve() / "library", Path(temp).resolve() / "project"
        for repo in (library, project):
            repo.mkdir()
            run("git", "init", "-b", "main", cwd=repo)
            for setting in (("user.name", "Swarm Test"), ("user.email", "swarm@example.invalid"), ("commit.gpgsign", "false")):
                run("git", "config", *setting, cwd=repo)
            (repo / "value").write_text("0")
            run("git", "add", ".", cwd=repo)
            run("git", "commit", "-m", "Initial", cwd=repo)
        def git(*args):
            return run("git", *args, cwd=project)
        git("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
        git("commit", "-m", "Add the library")
        board = [sys.executable, SCRIPTS / "board.py", run(sys.executable, SCRIPTS / "board.py", project / ".swarm" / "demo", "init", "Submodule")]
        gate = [sys.executable, SCRIPTS / "verify.py", board[2], project]
        run(*board, "member", "w")
        run(*board, "member", "verifier", "role=verifier")
        git("switch", "-c", "work")
        (project / "value").write_text("1")
        git("commit", "-am", "Change value")
        change = git("rev-parse", "HEAD")
        git("switch", "main")
        run(*board, "ready", "w", change, text="done")
        superseded = json.loads(run(*gate, "prepare", "isolated", "--check", "test -s value"))
        candidate = json.loads(run(*gate, "prepare", "isolated", "--check", "test -s value"))
        # the candidate it replaced leaves no checkout behind, in the run folder or in Git's list
        assert not Path(superseded["path"]).exists() and Path(candidate["path"]).exists()
        assert superseded["candidate"] not in git("worktree", "list")
        line = run(*gate, "test", candidate["candidate"], "verifier").splitlines()[-1]
        run(*board, "post", "verifier", "@coordinator " + line)
        (project / "vendor" / "lib" / "stray").write_text("local edit")  # a dirty submodule is still a difference
        dirty = verify.source_digest(project)
        run(*gate, "accept", candidate["candidate"], ok=False)
        (project / "vendor" / "lib" / "stray").unlink()
        assert verify.source_digest(project) != dirty
        run(*gate, "accept", candidate["candidate"])
        assert git("rev-parse", "HEAD") == candidate["commit"]
        assert json.loads((Path(board[2]) / "members.json").read_text())["accepted_seq"] == 2  # failed cycles count from here

        # prune removes an integration checkout no candidate needs, and nothing else in a run folder
        swarm = [sys.executable, SCRIPTS / "board.py", project / ".swarm", "prune"]
        left, own = Path(board[2]) / "integration-left", Path(board[2]) / "worker-tree"
        for tree in (left, own):
            git("worktree", "add", "--detach", str(tree), "HEAD")
        assert "would remove worktree %s" % left in run(*swarm, "--dry-run") and left.exists()
        done = run(*swarm)
        assert "remove worktree %s" % left in done and "remove 1 worktree(s) and archive 0 run(s)" in done
        assert not left.exists() and own.exists() and "integration-left" not in git("worktree", "list")


class VerifyScenario(unittest.TestCase):
    """One end-to-end scenario against temporary run folders, so `python3 -m unittest discover` finds and runs it."""

    def test_scenario(self):
        scenario()


class VerifyRegressions(unittest.TestCase):
    """Focused regression tests for verify.py fixes."""

    def _init_git(self, path, name="proj"):
        def g(*args, cwd=path):
            return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()
        g("init", "-b", "main")
        g("config", "user.name", "Test")
        g("config", "user.email", "test@example.com")
        g("config", "commit.gpgsign", "false")
        (path / "file.txt").write_text("v1")
        g("add", "file.txt")
        g("commit", "-m", "init")
        return g

    def test_git_strips_inherited_env_vars(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
            p1, p2 = Path(t1).resolve(), Path(t2).resolve()
            g1 = self._init_git(p1)
            self._init_git(p2)
            (p1 / "only1.txt").write_text("1")
            g1("add", "only1.txt")
            g1("commit", "-m", "second")
            old_git_dir = os.environ.get("GIT_DIR")
            old_work_tree = os.environ.get("GIT_WORK_TREE")
            try:
                os.environ["GIT_DIR"] = str(p1 / ".git")
                os.environ["GIT_WORK_TREE"] = str(p1)
                assert verify.source_digest(p2) != verify.source_digest(p1)
            finally:
                if old_git_dir is None:
                    os.environ.pop("GIT_DIR", None)
                else:
                    os.environ["GIT_DIR"] = old_git_dir
                if old_work_tree is None:
                    os.environ.pop("GIT_WORK_TREE", None)
                else:
                    os.environ["GIT_WORK_TREE"] = old_work_tree

    def test_source_digest_uninit_submodule_and_fake_git_and_nongit(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t_main, tempfile.TemporaryDirectory() as t_ng:
            sub, proj, ng = Path(t_sub).resolve(), Path(t_main).resolve(), Path(t_ng).resolve()
            gs = self._init_git(sub)
            sub_head = gs("rev-parse", "HEAD")
            gp = self._init_git(proj)
            subprocess.run(["git", "-C", str(proj), "-c", "protocol.file.allow=always", "submodule", "add", str(sub), "vendor/lib"],
                           check=True, capture_output=True)
            gp("commit", "-m", "add sub")
            gp("submodule", "deinit", "-f", "vendor/lib")
            before = verify.source_digest(proj)
            (proj / "vendor" / "lib" / "evil.txt").write_text("sneaky")
            assert verify.source_digest(proj) != before
            (proj / "vendor" / "lib" / "evil.txt").unlink()
            assert verify.source_digest(proj) == before
            # Empty/fake .git dir must not cause RecursionError
            fake_dir = proj / "fake"
            (fake_dir / ".git").mkdir(parents=True)
            (fake_dir / "a.txt").write_text("hi")
            assert verify.source_digest(proj)
            # Non-git os.walk prunes .swarm and .git
            (ng / "src.txt").write_text("ok")
            d1 = verify.source_digest(ng)
            (ng / ".swarm" / "run").mkdir(parents=True)
            (ng / ".swarm" / "run" / "noise").write_text("ignored")
            (ng / ".git").mkdir()
            (ng / ".git" / "noise").write_text("ignored")
            assert verify.source_digest(ng) == d1

    def test_accept_requires_verified_board_post_and_normalizes_verifier(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Verify reg")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            line = run(*gate, "test", cand["candidate"], "@V").splitlines()[-1]
            # Without VERIFIED post on board.jsonl, accept must fail
            run(*gate, "accept", cand["candidate"], ok=False)
            run(*post, "post", "v", "@coordinator " + line)
            run(*gate, "accept", cand["candidate"])

    def test_a_worker_registered_after_prepare_holds_up_neither_accept_nor_commit(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Late")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            (proj / "file.txt").write_text("v2")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
            # Seen live: a worker for follow-up work, registered after the pass, refused both with "waiting for READY".
            run(*post, "member", "late")
            run(*gate, "accept", cand)
            run(*post, "member", "late-2")
            assert "COMMITTED" in run(*gate, "commit", cand, "-m", "land")
            assert g("show", "HEAD:file.txt") == "v2"
            # A worker the candidate holds still counts: new work from it voids the pass.
            run(*post, "revise", "w", "one more thing")
            refused = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert refused.returncode != 0 and "@w" in refused.stderr and "@late" not in refused.stderr, refused.stderr

    def test_nochecks_revalidation_and_moved_submodule_fail_fast_and_prune_worktree(self):
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t_proj:
            sub, proj = Path(t_sub).resolve(), Path(t_proj).resolve()
            gs = self._init_git(sub)
            gp = self._init_git(proj)
            subprocess.run(["git", "-C", str(proj), "-c", "protocol.file.allow=always", "submodule", "add", str(sub), "vendor/lib"],
                           check=True, capture_output=True)
            gp("commit", "-m", "add sub")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Submodule reg")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "d", "profile=designer")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "d", text="spec")
            cand = json.loads(run(*gate, "prepare", "shared", "--no-checks"))
            run(*post, "member", "d", "profile=")  # designer -> plain worker invalidates --no-checks
            run(*gate, "test", cand["candidate"], "v", ok=False)
            # Isolated mode fails fast when worker commit moves a checked-out submodule gitlink
            run(*post, "member", "w")
            gp("switch", "-c", "work")
            (sub / "file.txt").write_text("v2")
            gs("add", "file.txt")
            gs("commit", "-m", "v2")
            subprocess.run(["git", "-C", str(proj / "vendor" / "lib"), "pull"], check=True, capture_output=True)
            gp("add", "vendor/lib")
            gp("commit", "-m", "bump sub")
            rev = gp("rev-parse", "HEAD")
            gp("switch", "main")
            run(*post, "ready", "d", text="spec2")
            run(*post, "ready", "w", rev, text="bumped")
            run(*gate, "prepare", "isolated", "--check", "true", ok=False)
            gp("submodule", "deinit", "-f", "vendor/lib")
            run(*gate, "prepare", "isolated", "--check", "true", ok=False)
            # Prune skips closed run containing active registered git worktree
            wt = Path(board) / "worker-wt"
            gp("worktree", "add", "--detach", str(wt), "HEAD")
            run(*post, "read", "coordinator")
            run(*post, "close")
            b2 = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "cur", "init", "Current")
            assert b2
            out = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm", "prune", "--days=0")
            assert "contains active git worktree" in out and wt.exists()

    def test_source_digest_dir_replaced_by_file_and_unborn_submodule_head(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t_proj:
            sub, proj = Path(t_sub).resolve(), Path(t_proj).resolve()
            gs = self._init_git(sub)
            gp = self._init_git(proj)
            (proj / "dir").mkdir()
            (proj / "dir" / "child.txt").write_text("hello")
            gp("add", "dir/child.txt")
            gp("commit", "-m", "add dir")
            # Replace tracked directory with regular file without staging
            (proj / "dir" / "child.txt").unlink()
            (proj / "dir").rmdir()
            (proj / "dir").write_text("now a file")
            d1 = verify.source_digest(proj)
            assert d1
            (proj / "dir").unlink()
            # Initialized submodule with unborn HEAD
            subprocess.run(["git", "-C", str(proj), "-c", "protocol.file.allow=always", "submodule", "add", str(sub), "vendor/lib"],
                           check=True, capture_output=True)
            gp("commit", "-m", "add sub")
            subprocess.run(["git", "-C", str(proj / "vendor" / "lib"), "checkout", "--orphan", "unborn"],
                           check=True, capture_output=True)
            subprocess.run(["git", "-C", str(proj / "vendor" / "lib"), "rm", "-rf", "."],
                           check=True, capture_output=True)
            assert verify.source_digest(proj)

    def test_timeout_validation_and_accept_idempotent_accepted_seq(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Timeout & accept_seq")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            passed = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            for bad_timeout in ("0", "-5", "nan", "inf", "abc"):
                env = dict(os.environ, SWARM_VERIFY_TIMEOUT=bad_timeout)
                res = subprocess.run([*gate, "test", cand["candidate"], "v"], capture_output=True, text=True, env=env)
                assert res.returncode != 0 and "SWARM_VERIFY_TIMEOUT must be a positive number" in res.stderr
            run(*post, "post", "v", "@coordinator " + passed)
            run(*gate, "accept", cand["candidate"])
            members_path = Path(board) / "members.json"
            state = json.loads(members_path.read_text())
            assert "accepted_seq" in state
            del state["accepted_seq"]
            members_path.write_text(json.dumps(state))
            run(*gate, "accept", cand["candidate"])
            assert "accepted_seq" in json.loads(members_path.read_text())

    def test_every_check_runs_and_two_verdicts_on_one_candidate_are_one_failure(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "All checks")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done" + "\n" + ANSWERS)
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "false", "--check", "echo second-ran", "--check", "test -e missing"))
            res = subprocess.run([*gate, "test", cand["candidate"], "v"], capture_output=True, text=True)
            # a failing first check does not hide what the others would have said
            assert res.returncode != 0 and "second-ran" in res.stdout, res.stdout
            assert "verification failed: false; test -e missing" in res.stderr, res.stderr
            # a source review and the test results that follow it are one failed cycle for the worker
            members_path = Path(board) / "members.json"
            run(*post, "post", "v", "@w NOT PASSED: source review")
            run(*post, "post", "v", "@w NOT PASSED: and the test results (adds to the above)")
            run(*post, "post", "v", "@w NOT PASSED: one more note on the same candidate")
            assert "paused" not in json.loads(members_path.read_text())
            # new work reviewed before the next candidate exists is a new cycle too, though the old candidate is on the table
            run(*post, "revise", "w", "fixing")
            run(*post, "ready", "w", text="done again\n" + ANSWERS)
            run(*post, "post", "v", "@w NOT PASSED: the fix is wrong, seen in review")
            assert "paused" not in json.loads(members_path.read_text())
            # a new candidate that fails is a new cycle
            run(*post, "revise", "w", "fixing")
            run(*post, "ready", "w", text="done a third time" + "\n" + ANSWERS)
            run(*gate, "prepare", "shared", "--check", "false")
            run(*post, "post", "v", "@w NOT PASSED: still failing")
            assert json.loads(members_path.read_text())["paused"] == "@w failed verification 3 times in a row"

    def test_negative_verdict_voids_the_pass_until_a_fresh_test(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Revoked pass")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "member", "v2", "role=verifier")
            run(*post, "ready", "w", text="done" + "\n" + ANSWERS)
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            # A rejection delivered during the check invalidates that attempt too.
            reject = shlex.join([str(arg) for arg in [*post, "post", "v2", "@w NOT PASSED reviewed during test"]])
            interrupted = json.loads(run(*gate, "prepare", "shared", "--check", reject))
            run(*gate, "test", interrupted["candidate"], "v", ok=False)
            assert "verified_by" not in json.loads((Path(board) / "verification.json").read_text())
            # The rejection also withdrew the worker's READY: no candidate is built on a report that was refused.
            refused = subprocess.run([*gate, "prepare", "shared", "--check", "test -s app.txt"], capture_output=True, text=True)
            assert refused.returncode != 0 and "waiting for READY from @w: its last one no longer counts" in refused.stderr
            run(*post, "post", "w", "@v fixed it, have a look")  # a plain reply is no report
            run(*gate, "prepare", "shared", "--check", "test -s app.txt", ok=False)
            run(*post, "ready", "w", text="fixed\n" + ANSWERS)
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            # A rejection that quotes the pass line is no pass.
            run(*post, "post", "v", "@coordinator NOT " + line)
            run(*gate, "accept", cand["candidate"], ok=False)
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            run(*post, "post", "v", "@coordinator " + line)
            # Any active verifier's later rejection voids the pass, and posting the old line again does not restore it.
            run(*post, "post", "v2", "@w @coordinator NOT PASSED regression identified; reject this candidate")
            run(*gate, "accept", cand["candidate"], ok=False)
            run(*post, "post", "v", "@coordinator " + line, ok=False)
            run(*gate, "accept", cand["candidate"], ok=False)
            # The candidate rests on the refused report, so it cannot be tested again either: the worker reports, and a
            # new candidate is prepared.
            run(*gate, "test", cand["candidate"], "v", ok=False)
            run(*post, "ready", "w", text="regression fixed" + "\n" + ANSWERS)
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            run(*post, "post", "v", "@coordinator " + line)
            run(*gate, "accept", cand["candidate"])

    def test_timed_out_check_leaves_no_descendant_running(self):
        with tempfile.TemporaryDirectory() as t, tempfile.TemporaryDirectory() as outside:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            marker = Path(outside) / "marker"
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Timeout tree")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            # The shell has a command after the child, so it cannot exec the child in its own place. The child
            # ignores a polite termination.
            child = ("import signal, time, pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                     "time.sleep(1.5); pathlib.Path(%r).write_text('late')" % str(marker))
            check = "%s -c %s; true" % (shlex.quote(sys.executable), shlex.quote(child))
            cand = json.loads(run(*gate, "prepare", "shared", "--check", check))
            env = dict(os.environ, SWARM_VERIFY_TIMEOUT="0.3")
            res = subprocess.run([*gate, "test", cand["candidate"], "v"], capture_output=True, text=True, env=env)
            assert res.returncode != 0 and "timed out" in res.stderr, res.stderr
            import time
            time.sleep(2)
            assert not marker.exists(), "a descendant of the timed-out check kept running"

    def test_accept_does_not_overwrite_an_ignored_file(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / ".gitignore").write_text("*.cfg\n*.log\n.claude/\n")
            (proj / "pkg").mkdir()
            (proj / "pkg" / "item.txt").write_text("old")
            g("add", ".gitignore", "pkg")
            g("commit", "-m", "ignore")
            g("switch", "-c", "w-work")
            (proj / "local.cfg").write_text("W")
            (proj / "dir.cfg").mkdir()
            (proj / "dir.cfg" / "settings.txt").write_text("S")
            g("rm", "-rq", "pkg")
            (proj / "pkg").write_text("file")  # a tracked folder replaced by a file must not be taken for a local one
            g("add", "-f", "local.cfg", "dir.cfg", "pkg")
            g("commit", "-m", "add cfg")
            commit = g("rev-parse", "HEAD")
            g("switch", "main")
            (proj / "local.cfg").write_text("X")  # the user's own, ignored
            (proj / "dir.cfg").write_text("D")  # ignored, where the candidate puts a folder
            (proj / "junk.log").write_text("noise")  # unrelated ignored output must not block
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Ignored")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", commit, text="done")
            cand = json.loads(run(*gate, "prepare", "isolated", "--check", "true"))
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand["candidate"], "v").splitlines()[-1])
            res = subprocess.run([*gate, "accept", cand["candidate"]], capture_output=True, text=True)
            assert res.returncode != 0 and "local.cfg" in res.stderr and "dir.cfg" in res.stderr, res.stderr
            assert (proj / "local.cfg").read_text() == "X" and (proj / "dir.cfg").read_text() == "D"
            (proj / "local.cfg").unlink()
            (proj / "dir.cfg").unlink()
            run(*gate, "accept", cand["candidate"])
            assert (proj / "local.cfg").read_text() == "W" and (proj / "junk.log").exists()
            assert (proj / "dir.cfg" / "settings.txt").read_text() == "S" and (proj / "pkg").read_text() == "file"

    def test_linked_worktrees_inside_the_project_are_not_source(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            before = verify.source_digest(proj)
            g("worktree", "add", "-q", "-b", "agent-x", str(proj / ".claude" / "worktrees" / "agent-x"))
            (proj / ".claude" / "worktrees" / "agent-x" / "scratch").write_text("work")
            assert g("status", "--porcelain", "--untracked-files=all")  # git itself lists the worktree
            assert verify.pending_changes(proj) == []
            assert verify.source_digest(proj) == before
            # a user's own nested repository still counts
            nested = proj / "vendor"
            nested.mkdir()
            self._init_git(nested)
            assert verify.pending_changes(proj) == [b"vendor/"]
            assert verify.source_digest(proj) != before

    def test_check_environment_drops_git_variables(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t:
            out = Path(t) / "out"
            old = os.environ.get("GIT_DIR")
            os.environ["GIT_DIR"] = "/nonexistent"
            try:
                verify.run_check('printf "%s" "${GIT_DIR-unset}" > ' + shlex.quote(str(out)), t, 10)
            finally:
                if old is None:
                    os.environ.pop("GIT_DIR")
                else:
                    os.environ["GIT_DIR"] = old
            assert out.read_text() == "unset"

    def test_timeout_ends_descendants_in_their_own_group(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        import time
        with tempfile.TemporaryDirectory() as t:
            marker = Path(t) / "marker"
            child = ("import os, time, pathlib; os.setpgid(0, 0); time.sleep(1.5); "
                     "pathlib.Path(%r).write_text('late')" % str(marker))
            check = "%s -c %s & sleep 30" % (shlex.quote(sys.executable), shlex.quote(child))
            try:
                verify.run_check(check, t, 0.4)
                raise AssertionError("expected a timeout")
            except subprocess.TimeoutExpired:
                pass
            time.sleep(2)
            assert not marker.exists(), "a descendant in its own process group kept running"

    def test_ready_head_refuses_untracked_source(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve() / "main"
            proj.mkdir()
            g = self._init_git(proj)
            (proj / ".gitignore").write_text("build/\n")
            g("add", ".gitignore")
            g("commit", "-m", "ignore build")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Untracked")
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "w")
            work = proj.parent / "worker"
            g("worktree", "add", "-b", "worker", str(work))
            (work / "build").mkdir()
            (work / "build" / "out.o").write_text("ignored")
            (work / "pkg").mkdir()
            (work / "pkg" / "new_feature.py").write_text("def feature(): return 42\n")
            res = subprocess.run([*post, "ready", "w", "HEAD"], cwd=work / "build", input="added new_feature.py",
                                 capture_output=True, text=True)
            assert res.returncode != 0 and "pkg/new_feature.py" in res.stderr, res.stderr
            g("add", "pkg", cwd=work)
            g("commit", "-m", "feature", cwd=work)
            # Ignored build output does not block the report, wherever in the checkout it is made from.
            run(*post, "ready", "w", "HEAD", cwd=work / "build", text="added new_feature.py")

    def test_accept_requires_verified_after_rejection_and_timeout_flag_and_nongit_pending(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Rejection seq")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            run(*post, "post", "v", "@coordinator " + line)
            run(*post, "post", "v", "@coordinator NOT VERIFIED: recheck needed")
            # Re-running test restores verified_by, but accept must still require a new VERIFIED post after the rejection.
            line2 = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            run(*gate, "accept", cand["candidate"], ok=False)
            run(*post, "post", "v", "@coordinator " + line2)
            run(*gate, "accept", cand["candidate"])

            # --timeout overrides SWARM_VERIFY_TIMEOUT and validates finite positive numbers
            cand2 = json.loads(run(*gate, "prepare", "shared", "--check", "sleep 1"))
            env = dict(os.environ, SWARM_VERIFY_TIMEOUT="invalid")
            res = subprocess.run([*gate, "test", cand2["candidate"], "v", "--timeout", "0.2"],
                                 capture_output=True, text=True, env=env)
            assert res.returncode != 0 and "timed out" in res.stderr, res.stderr
            for bad in ("", "0", "-1", "nan", "inf", "abc"):
                run(*gate, "test", cand2["candidate"], "v", "--timeout", bad, ok=False)

            # pending_changes outside a git repository raises ValueError, not TypeError
            sys.path.insert(0, str(SCRIPTS))
            try:
                import verify
                with self.assertRaises(ValueError):
                    verify.pending_changes(proj)
            finally:
                sys.path.remove(str(SCRIPTS))


    # The findings of the 2026-11-21 review, each test named after its number there (`low` for the unnumbered ones).

    def test_f09_ready_head_in_a_subfolder_project_leaves_out_its_run_data(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as t:
            repo = Path(t).resolve()
            g = self._init_git(repo)
            proj = repo / "package"
            (proj / ".swarm").mkdir(parents=True)
            (proj / ".swarm" / ".gitignore").write_text("integration-*\n")  # the project's own: run data shows in git status
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Subfolder")
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "w")
            (proj / "feature.py").write_text("x = 1\n")
            refused = subprocess.run([*post, "ready", "w", "HEAD"], cwd=proj, input="added", capture_output=True, text=True)
            assert refused.returncode != 0 and "package/feature.py" in refused.stderr and ".swarm" not in refused.stderr, refused.stderr
            g("add", "package/feature.py")
            g("commit", "-m", "feature")
            assert "posted #1" in run(*post, "ready", "w", "HEAD", cwd=repo, text="added feature.py")
            # A checkout Git stops answering for between the two questions is refused in words, not with a traceback.
            sys.path.insert(0, str(SCRIPTS))
            here = os.getcwd()
            try:
                import board as board_module
                import verify
                os.chdir(repo)
                with mock.patch.object(verify, "toplevel", lambda path: None), self.assertRaises(SystemExit) as stopped:
                    board_module.main(["board.py", board, "ready", "w", "HEAD"])
                assert "HEAD cannot be reported" in str(stopped.exception.code), stopped.exception.code
            finally:
                os.chdir(here)
                sys.path.remove(str(SCRIPTS))

    def test_f15_linked_swarm_folder_empty_base_and_process_table_noise(self):
        from types import SimpleNamespace
        from unittest import mock
        with tempfile.TemporaryDirectory() as t, tempfile.TemporaryDirectory() as elsewhere:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            (proj / ".swarm").symlink_to(Path(elsewhere).resolve(), target_is_directory=True)
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Linked")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -s app.txt"))
            assert run(*gate, "test", cand["candidate"], "v").splitlines()[-1].startswith("VERIFIED " + cand["candidate"])
            for mode in ("shared", "isolated"):
                refused = subprocess.run([*gate, "prepare", mode, "--check", "true", "--base", ""], capture_output=True, text=True)
                assert refused.returncode != 0 and "--base" in refused.stderr, (mode, refused.stderr)
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            table = "PID PPID PGID\nnot a row here\n 10 1 0\n 11 10 11\n 12 11 1\n 13 12 13\n"
            with mock.patch.object(verify.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=table, returncode=0)):
                assert verify.descendant_groups(10) == {11, 13}  # never group 0 (the caller's own) or 1 (init's)
            with mock.patch.object(verify.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=table, returncode=1)):
                assert verify.descendant_groups(10) == set()
        finally:
            sys.path.remove(str(SCRIPTS))

    def _isolated_candidate(self, proj, change):
        """A run with one worker whose commit CHANGE made, ready for `prepare isolated`."""
        g = self._init_git(proj)
        base = g("rev-parse", "HEAD")
        board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Isolated")
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        g("switch", "-q", "-c", "work")
        change(g)
        g("commit", "-q", "-m", "work")
        commit = g("rev-parse", "HEAD")
        g("switch", "-q", "main")
        run(*post, "ready", "w", commit, text="done")
        return g, base, board, post, gate

    def test_low_a_commit_that_writes_run_data_is_no_candidate(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / ".swarm" / "note.txt").write_text("not source")
                g("add", "-f", ".swarm/note.txt")
            _, _, board, _, gate = self._isolated_candidate(proj, change)
            refused = subprocess.run([*gate, "prepare", "isolated", "--check", "true"], capture_output=True, text=True)
            assert refused.returncode != 0 and ".swarm/note.txt" in refused.stderr and "@w" in refused.stderr, refused.stderr
            assert not list(Path(board).glob("integration-*")) and not (Path(board) / "verification.json").exists()

    def test_low_acceptance_rolls_back_whatever_stops_it(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            cand = json.loads(run(*gate, "prepare", "isolated", "--check", "true"))
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand["candidate"], "v").splitlines()[-1])
            sys.path.insert(0, str(SCRIPTS))
            try:
                import verify
                real = verify.source_digest

                def interrupted(path, *args, **kwargs):
                    if Path(path) == proj:
                        raise KeyboardInterrupt
                    return real(path, *args, **kwargs)
                with mock.patch.object(verify, "source_digest", interrupted), self.assertRaises(KeyboardInterrupt):
                    verify.accept(Path(board), proj, cand["candidate"])
            finally:
                sys.path.remove(str(SCRIPTS))
            assert g("rev-parse", "HEAD") == base and (proj / "file.txt").read_text() == "v1"
            run(*gate, "accept", cand["candidate"])
            assert g("rev-parse", "HEAD") == cand["commit"]

    def test_a_partial_candidate_is_tested_and_never_accepted(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            run(*post, "member", "other")
            run(*gate, "prepare", "isolated", "--check", "true", ok=False)  # @other has not reported
            for bad in ("ghost", "v", " , "):
                run(*gate, "prepare", "isolated", "--check", "true", "--members", bad, ok=False)
            cand = json.loads(run(*gate, "prepare", "isolated", "--check", "true", "--members", "@w"))
            record = json.loads((Path(board) / "verification.json").read_text())
            assert cand["partial"] and record["partial"] and record["members"] == ["w"] and list(record["inputs"]) == ["w"]
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            assert "note: this pass is of a partial candidate holding @w" in run(*post, "post", "v", "@coordinator " + line)
            with open(Path(board) / "board.jsonl", encoding="utf-8") as f:
                assert json.loads(f.read().splitlines()[-1])["partial"] is True
            refused = subprocess.run([*gate, "accept", cand["candidate"]], capture_output=True, text=True)
            assert refused.returncode != 0 and "partial candidate" in refused.stderr, refused.stderr
            assert g("rev-parse", "HEAD") == base
            # a worker outside it reporting leaves the partial pass standing, and no stale verification is claimed
            run(*post, "ready", "other", text="done")
            run(*post, "post", "v", "@coordinator " + line)
            kinds = [item["kind"] for item in json.loads(run(*post, "attention", "--json"))["items"]]
            assert "stale" not in kinds, kinds
            run(*post, "revise", "w", "one more thing")
            run(*post, "post", "v", "@coordinator " + line, ok=False)
            run(*post, "read", "coordinator")
            assert "passed earlier, now stale: waiting for READY from @w" in run(*post, "close")

    def test_trial_merge_names_conflicting_files_per_peer(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                g = self._init_git(proj)
                base = g("rev-parse", "HEAD")
                commits = {}
                for branch, name in (("mine", "file.txt"), ("theirs", "file.txt"), ("apart", "other.txt")):
                    g("switch", "-q", "-c", branch, base)
                    (proj / name).write_text(branch)
                    g("add", name)
                    g("commit", "-q", "-m", branch)
                    commits[branch] = g("rev-parse", "HEAD")
                others = {"theirs": commits["theirs"], "apart": commits["apart"], "unknown": "0" * 40}
                assert verify.trial_merge(proj, None, commits["mine"], others) == {"theirs": ["file.txt"]}
                assert verify.trial_merge(proj, base, commits["mine"], others) == {"theirs": ["file.txt"]}
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_low_a_check_that_ends_leaves_nothing_running(self):
        import time
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            with tempfile.TemporaryDirectory() as t:
                marker = Path(t) / "marker"
                child = "import time, pathlib; time.sleep(1.2); pathlib.Path(%r).write_text('late')" % str(marker)
                check = "%s -c %s & exit 3" % (shlex.quote(sys.executable), shlex.quote(child))
                assert verify.run_check(check, t, None) == 3
                time.sleep(1.8)
                assert not marker.exists(), "what a finished check left in the background kept running"
        finally:
            sys.path.remove(str(SCRIPTS))

    # The audit of 0.3.47.

    def test_a_rejection_on_review_wakes_only_the_rejected_worker(self):
        """Seen live (2026-11-25): a NOT PASSED for one worker that also said "@core: both fixes pass" woke @core; the
        rejected worker's REVISE woke the verifier and the coordinator; and its READY printed the coordinator's
        UNREAD notice, so it read the board again. Each was a turn at a member's whole context, for nothing."""
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            for name in ("a", "b"):
                run(*post, "member", name)
            run(*post, "member", "v", "role=verifier")

            def last_post():
                return json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            assert run(sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
            run(*post, "ready", "a", text="done a")
            (proj / "b.txt").write_text("b\n")
            said = run(*post, "ready", "b", text="done b")
            first = json.loads((board / "verification.json").read_text())["candidate"]
            # The candidate goes up in the coordinator's name, and its backlog is not the worker's to read.
            assert first in said and "UNREAD" not in said, said
            assert "needs no word to the coordinator" in last_post()["text"]
            run(*post, "read", "v")
            # Rejected on review, before any test: no `attempt` and no `verified_by` is on the candidate yet.
            said = run(*post, "post", "v", "@b NOT PASSED %s\n- b.txt: wrong\n@a: reviewed, your fix passes." % first)
            verdict = last_post()
            assert verdict["rejects"] == ["b"] and verdict["to"] == ["b"], verdict
            assert "@a is not woken" in said, said
            # The verdict killed the candidate, and its author knows: the REVISE that answers it wakes nobody.
            assert run(*post, "revise", "b", "fixing F1").startswith("posted #%d -> nobody" % (verdict["seq"] + 1))
            # A worker the verdict did not reject still withdraws work the candidate holds: the verifier hears.
            assert "@v" in run(*post, "revise", "a", "one more thing")
            # And once the rejected worker has reported again, its next withdrawal is news to the verifier again.
            run(*post, "ready", "b", text="F1: fixed \u2014 b.txt, checked by hand")
            assert "@v" in run(*post, "revise", "b", "a second flaw")

    def test_a_planned_candidate_is_prepared_by_the_ready_that_completes_the_team(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            for name in ("a", "b"):
                run(*post, "member", name)
            run(*post, "member", "v", "role=verifier")

            def candidate():
                return json.loads((board / "verification.json").read_text())["candidate"]

            def last_post():
                return json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            # Recorded while nobody is ready: nothing is prepared, and nothing fails.
            assert run(*gate, "prepare", "shared", "--check", "test -d .git", "--when-ready").startswith("planned:")
            assert not (board / "verification.json").exists()
            assert "candidate" not in run(*post, "ready", "a", text="done a")
            # The READY that completes the team prepares it and hands the verifier the exact command.
            said = run(*post, "ready", "b", text="done b")
            first = candidate()
            request = last_post()
            assert first in said and request["agent"] == "coordinator" and request["to"] == ["v"], (said, request)
            command = request["text"].splitlines()[-1]
            assert command.endswith("test %s v" % first), command
            tested = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=proj)
            assert tested.returncode == 0 and "VERIFIED " + first in tested.stdout, tested.stderr
            # A follow-up worker's READY that changes no file leaves the candidate, and its pass, where they are.
            run(*post, "member", "late")
            assert first in run(*post, "ready", "late", text="triage only, no files touched")
            assert candidate() == first and last_post()["agent"] == "late", last_post()
            # Nor does a consultant's report: it contributes nothing to the candidate.
            run(*post, "member", "arch", "profile=architect", "writes=0", "consult=1")
            assert first in run(*post, "ready", "arch", text="advice only")
            assert candidate() == first
            # A NOT PASSED against the follow-up worker holds the candidate up: a pass would close its finding unseen.
            run(*post, "post", "v", "@late NOT PASSED: F1 the triage missed a thread")
            def held():
                done = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=proj)
                return done.returncode and done.stderr
            assert "waiting for READY from @late" in held(), held()
            run(*post, "revise", "late", "looking at the thread")  # withdrawing its report answers nothing
            assert "waiting for READY from @late" in held(), held()
            run(*post, "replace", "late", "late2")  # nor does a successor, whose finding it now is
            assert "waiting for READY from @late2" in held(), held()
            # Retiring the last worker that is not ready completes the team: the plan runs then too.
            assert first in run(*post, "member", "late2", "killed=1")
            # After a rework the next READY prepares the next one, again with no word from the coordinator.
            run(*post, "post", "v", "@a NOT PASSED: F2 the file is missing a line")
            assert candidate() == first
            (proj / "added.txt").write_text("the missing work\n")
            assert "candidate" in run(*post, "ready", "a", text="F2: fixed — added the line, test -d .git passes")
            assert candidate() != first and candidate() in last_post()["text"]
            assert f"Compared with {first}, 1 changed source path: added.txt" in last_post()["text"]
            # The fingerprints the comparison reads are kept apart: each verifier attempt rewrites the record, not them.
            assert "source_entries" not in json.loads((board / "verification.json").read_text())
            # A plan that cannot be prepared is the coordinator's to hear of, from the member whose READY met it.
            (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true", "--base", "main"]))
            run(*post, "post", "v", "@b NOT PASSED: F3 one more")
            run(*post, "ready", "b", text="F3: fixed — done")
            failed = last_post()
            assert failed["agent"] == "b" and failed["to"] == ["coordinator"] and "--base is for an isolated candidate" in failed["text"], failed
            # Planned again with everyone ready: prepared at once, and the request goes to every verifier in one post.
            run(*post, "member", "v2", "role=verifier")
            before = candidate()
            again = run(*gate, "prepare", "shared", "--check", "test -d .git", "--check", "true", "--when-ready")
            request = last_post()
            assert candidate() != before and candidate() in again and request["to"] == ["v", "v2"], (again, request)
            assert request["text"].endswith("test %s <you>" % candidate()), request["text"]
            json.loads(run(*post, "attention", "--json"))  # the journal still reads: one post, one number

    def test_prepare_plan_uses_parsed_arguments(self):
        with tempfile.TemporaryDirectory() as t:
            project = Path(t).resolve() / "prepare"
            project.mkdir()
            script = [sys.executable, SCRIPTS / "board.py"]
            board = Path(run(*script, project / ".swarm" / "plan", "init", "Plan"))
            run(*script, board, "member", "w")
            gate = [sys.executable, SCRIPTS / "verify.py", board, "prepare"]
            assert run(*gate, "prepare", "shared", "--check=--keep-standing", "--when-ready", cwd=t).startswith("planned:")
            plan = json.loads((board / "verification-plan.json").read_text())
            assert plan == ["shared", "--check=--keep-standing"]

    @staticmethod
    def _served(board, timeout=20):
        """The candidate the owed dispatch's waiter prepared, once it has cleared what it owed."""
        stop = time.monotonic() + timeout
        while time.monotonic() < stop:
            state = json.loads((board / "members.json").read_text())
            if "owed_dispatch" not in state and (board / "verification.json").exists():
                return json.loads((board / "verification.json").read_text())["candidate"]
            time.sleep(0.05)
        raise AssertionError("the owed dispatch was not served: %s" % (board / "members.json").read_text())

    def test_a_planned_candidate_the_verification_lock_held_up_is_prepared_when_the_lock_is_let_go(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "member", "v", "role=verifier")
            assert run(*gate, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
            with (proj / ".git" / ".verification.lock").open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX)  # a verifier's test, say, still running
                said = run(*post, "ready", "a", text="done a")
                assert "waits for the verification action" in said, said
                time.sleep(0.3)
                assert not (board / "verification.json").exists()
                assert "could not be prepared" not in (board / "board.jsonl").read_text()
                # Recorded in the run's state while the waiter waits: nothing the lock's holder must remember.
                assert json.loads((board / "members.json").read_text())["owed_dispatch"]["author"] == "a"
            candidate = self._served(board)
            request = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            assert request["to"] == ["v"] and request["text"].endswith("test %s v" % candidate), request

    def test_a_planned_candidate_held_up_by_another_project_or_a_prune_is_prepared_when_that_lets_go(self):
        # Two projects in one checkout share its verification lock, and prune takes it naming no project.
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            with tempfile.TemporaryDirectory() as t:
                root = Path(t).resolve()
                self._init_git(root)
                proj = root / "b"
                proj.mkdir()
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                assert run(*gate, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
                with verify.verification_lock(root / ".git"):  # as `board.py .swarm prune` holds it, from the top
                    assert "waits for the verification action" in run(*post, "ready", "a", text="done a")
                    assert not (board / "verification.json").exists()
                candidate = self._served(board)
                request = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
                assert request["to"] == ["v"] and request["text"].endswith("test %s v" % candidate), request
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_an_owed_dispatch_whose_waiter_ended_is_the_coordinators_to_hear(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "a")
            state = json.loads((board / "members.json").read_text())
            dead = subprocess.Popen([sys.executable, "-c", "pass"])
            dead.wait()
            state["owed_dispatch"] = {"token": "t1", "author": "a", "pid": dead.pid}
            (board / "members.json").write_text(json.dumps(state))
            items = json.loads(run(*post, "attention", "--json"))["items"]
            assert [i["kind"] for i in items if i["kind"] == "dispatch"] == ["dispatch"], items

    def test_two_dispatches_that_meet_on_one_candidate_ask_each_verifier_once(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                real, met = subprocess.run, []

                def overtaken(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv and not met:  # another dispatch posts for the same candidate meanwhile
                        met.append(real([*post, "dispatch"], capture_output=True, text=True, check=True).stdout)
                    return done
                with mock.patch.object(module.subprocess, "run", overtaken), \
                        contextlib.redirect_stdout(io.StringIO()) as said:
                    module.main(["board.py", str(board), "dispatch"])
                requests = [p for p in map(json.loads, (board / "board.jsonl").read_text().splitlines()) if "CANDIDATE" in p["text"]]
                assert len(requests) == 1 and requests[0]["to"] == ["v"], (requests, met, said.getvalue())
                # The candidate stands by now (the dispatch that met this one posted it), or is this one's own.
                assert re.search(r"every verifier (?:already )?has its test command", said.getvalue()), said.getvalue()
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_live_waiter_keeps_serving_an_owed_dispatch_and_one_past_its_deadline_tells_the_coordinator(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                kinds = lambda: [i["kind"] for i in json.loads(run(*post, "attention", "--json"))["items"]]
                # A process that merely has the id a waiter had serves nothing: only the waiter lock tells.
                stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
                waiter = None
                try:
                    state = json.loads((board / "members.json").read_text())
                    state["owed_dispatch"] = {"token": "t1", "author": "a", "pid": stranger.pid}
                    (board / "members.json").write_text(json.dumps(state))
                    assert "dispatch" in kinds()
                    # A waiter that holds the lock keeps serving: a busy READY starts no second one.
                    waiter = subprocess.Popen([sys.executable, "-c", (
                        "import fcntl, sys, time; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); "
                        "print('held', flush=True); time.sleep(60)"), str(board / ".dispatch-waiter")],
                        stdout=subprocess.PIPE, text=True)
                    assert waiter.stdout.readline().strip() == "held"
                    assert "dispatch" not in kinds()
                    with (proj / ".git" / ".verification.lock").open("a") as held:
                        fcntl.flock(held, fcntl.LOCK_EX)
                        assert "waits for the verification action" in run(*post, "ready", "a", text="done a")
                        assert json.loads((board / "members.json").read_text())["owed_dispatch"]["token"] != "t1"
                        waiter.kill()
                        waiter.wait()
                        # A waiter whose lock stays held past its deadline stops waiting, says so, and prepares nothing
                        # after it, even when the lock is let go just then; the dispatch stays owed, for attention.
                        real = module.subprocess.run

                        def freed(argv, *args, **kwargs):
                            if "prepare" in argv:  # a prepare after the deadline would find the lock free
                                fcntl.flock(held, fcntl.LOCK_UN)
                            return real(argv, *args, **kwargs)
                        with mock.patch.object(module, "OWED_WAIT_S", 0.5), mock.patch.object(module.subprocess, "run", freed), \
                                contextlib.redirect_stdout(io.StringIO()):
                            module.main(["board.py", str(board), "dispatch", "--owed"])
                    last = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
                    assert last["to"] == ["coordinator"] and "still not prepared" in last["text"], last
                    assert not (board / "verification.json").exists()
                    assert json.loads((board / "members.json").read_text())["owed_dispatch"]["failed"]
                    assert "dispatch" in kinds()
                    # Served by hand, as attention asks: the request is posted and the item goes.
                    assert "posted to the verifier" in run(*post, "dispatch")
                    assert "owed_dispatch" not in json.loads((board / "members.json").read_text())
                    assert "dispatch" not in kinds()
                finally:
                    for one in (stranger, waiter):
                        if one is not None:
                            one.kill()
                            one.wait()
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_process_that_reused_a_waiters_id_does_not_stand_in_for_it(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "member", "v", "role=verifier")
            assert run(*gate, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
            stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            try:
                state = json.loads((board / "members.json").read_text())
                state["owed_dispatch"] = {"token": "t1", "author": "a", "pid": stranger.pid}
                (board / "members.json").write_text(json.dumps(state))
                with (proj / ".git" / ".verification.lock").open("a") as held:
                    fcntl.flock(held, fcntl.LOCK_EX)
                    assert "waits for the verification action" in run(*post, "ready", "a", text="done a")
                self._served(board)  # a real waiter was started, and served it
            finally:
                stranger.kill()
                stranger.wait()

    def test_a_dispatch_clears_only_the_owed_entry_it_served(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                state = json.loads((board / "members.json").read_text())
                state["owed_dispatch"] = {"n": 1, "token": "first", "author": "a", "failed": "its waiter ended"}
                (board / "members.json").write_text(json.dumps(state))
                real = subprocess.run

                def renewed(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv:  # meanwhile that entry was served, and a newer refusal owes another
                        now = json.loads((board / "members.json").read_text())
                        now["owed_dispatch"] = {"n": 1, "token": "second", "author": "b"}
                        (board / "members.json").write_text(json.dumps(now))
                    return done
                with mock.patch.object(module.subprocess, "run", renewed), contextlib.redirect_stdout(io.StringIO()):
                    module.main(["board.py", str(board), "dispatch"])
                assert json.loads((board / "members.json").read_text())["owed_dispatch"]["token"] == "second"
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_dispatch_owed_after_its_candidate_was_prepared_still_posts_the_request_once(self):
        # The waiter prepared the candidate and died before it posted: `dispatch`, as attention asks, posts it.
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "a", text="done a")
            candidate = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
            state = json.loads((board / "members.json").read_text())
            state["owed_dispatch"] = {"token": "t1", "author": "a"}
            (board / "members.json").write_text(json.dumps(state))
            assert "dispatch" in [i["kind"] for i in json.loads(run(*post, "attention", "--json"))["items"]]
            assert "posted to the verifier" in run(*post, "dispatch")
            assert "every verifier has its test command" in run(*post, "dispatch")
            requests = [p for p in map(json.loads, (board / "board.jsonl").read_text().splitlines()) if p.get("requests")]
            assert [(p["requests"], p["to"]) for p in requests] == [(candidate, ["v"])], requests
            assert "owed_dispatch" not in json.loads((board / "members.json").read_text())

    def test_a_verifiers_successor_agent_reads_the_test_request_its_predecessor_read(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "member", "v", "role=verifier", "id=v-1")
            assert run(*gate, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
            run(*post, "ready", "a", text="done a")
            candidate = json.loads((board / "verification.json").read_text())["candidate"]
            assert "test %s v" % candidate in run(*post, "read", "v")
            run(*post, "started", "v", "v-2", "v-1")  # a new agent for v, reading on from v-1's cursor
            assert "test %s v" % candidate in run(*post, "read", "v")
            assert "test %s v" % candidate not in run(*post, "read", "v")  # once

    def test_a_note_that_names_a_candidate_is_no_test_request(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "ready", "a", text="done a")
            candidate = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "member", "v", "role=verifier")
            run(*post, "post", "coordinator", "@v CANDIDATE %s is on the table; wait for instructions." % candidate)
            (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
            assert "posted to the verifier" in run(*post, "dispatch")
            request = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            assert request["requests"] == candidate and request["to"] == ["v"], request

    def test_a_planned_candidate_prepared_as_the_run_closes_is_not_requested(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                real = subprocess.run

                def closing(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv:
                        real([*post, "kill", "ended"], capture_output=True, text=True, check=True)
                    return done
                with mock.patch.object(module.subprocess, "run", closing), contextlib.redirect_stdout(io.StringIO()) as said:
                    module.main(["board.py", str(board), "dispatch"])
                assert "no test command is posted" in said.getvalue(), said.getvalue()
                assert '"requests"' not in (board / "board.jsonl").read_text()
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_candidate_whose_comparison_record_cannot_be_written_still_stands(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "ready", "a", text="done a")
                real = verify.atomic_write

                def failing(path, text):
                    if Path(path).name == verify.SOURCES_FILE:
                        raise OSError("disk full")
                    return real(path, text)
                with mock.patch.object(verify, "atomic_write", failing), \
                        contextlib.redirect_stdout(io.StringIO()) as said, contextlib.redirect_stderr(io.StringIO()):
                    verify.prepare(board, proj, "shared", ["true"])
                made = json.loads(said.getvalue().strip().splitlines()[-1])
                assert json.loads((board / "verification.json").read_text())["candidate"] == made["candidate"]
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_candidate_record_that_cannot_be_read_back_is_a_failure_not_a_replacement(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                real = subprocess.run

                def torn(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv:
                        (board / "verification.json").write_text("{not json")
                    return done
                with mock.patch.object(module.subprocess, "run", torn), contextlib.redirect_stdout(io.StringIO()) as said:
                    with self.assertRaises(SystemExit) as stop:  # a failed preparation fails the command
                        module.main(["board.py", str(board), "dispatch"])
                assert stop.exception.code == 1
                assert "could not be read back" in said.getvalue() and "replaced by" not in said.getvalue(), said.getvalue()
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_planned_candidate_another_prepare_replaced_meanwhile_is_not_handed_out(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                real, newer = subprocess.run, []

                def overtaken(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv and not newer:  # a second prepare lands while this one's board is unlocked
                        (proj / "late.txt").write_text("later work\n")
                        newer.append(json.loads(real([*gate, "prepare", "shared", "--check", "true"], capture_output=True,
                                                     text=True, check=True).stdout)["candidate"])
                    return done
                with mock.patch.object(module.subprocess, "run", overtaken), \
                        contextlib.redirect_stdout(io.StringIO()) as said:
                    module.main(["board.py", str(board), "dispatch"])
                current = json.loads((board / "verification.json").read_text())["candidate"]
                assert current == newer[0] and "replaced by " + current in said.getvalue(), said.getvalue()
                assert "CANDIDATE" not in (board / "board.jsonl").read_text()
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_an_owed_dispatch_overtaken_by_the_planned_dispatch_of_a_newer_ready_leaves_that_one_requested(self):
        # The candidate that replaced this one came from the board's own plan: its dispatch posted its request, so
        # clearing the owed entry loses nothing. (A candidate prepared by hand is the coordinator's to hand out.)
        sys.path.insert(0, str(SCRIPTS))
        try:
            import board as module
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                self._init_git(proj)
                board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "a")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "a", text="done a")
                (board / "verification-plan.json").write_text(json.dumps(["shared", "--check", "true"]))
                state = json.loads((board / "members.json").read_text())
                state["owed_dispatch"] = {"token": "t1", "author": "a", "failed": "its waiter ended"}
                (board / "members.json").write_text(json.dumps(state))
                real, newer = subprocess.run, []

                def overtaken(argv, *args, **kwargs):
                    done = real(argv, *args, **kwargs)
                    if "prepare" in argv and not newer:  # a newer READY's planned dispatch lands meanwhile
                        (proj / "late.txt").write_text("later work\n")
                        newer.append(real([*post, "dispatch"], capture_output=True, text=True, check=True).stdout)
                    return done
                with mock.patch.object(module.subprocess, "run", overtaken), \
                        contextlib.redirect_stdout(io.StringIO()) as said:
                    module.main(["board.py", str(board), "dispatch"])
                current = json.loads((board / "verification.json").read_text())["candidate"]
                assert "replaced by " + current in said.getvalue(), said.getvalue()
                requests = [p for p in map(json.loads, (board / "board.jsonl").read_text().splitlines()) if p.get("requests")]
                assert [(p["requests"], p["to"]) for p in requests] == [(current, ["v"])], requests
                assert "owed_dispatch" not in json.loads((board / "members.json").read_text())
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_a_verifier_registered_after_the_planned_candidate_gets_its_test_command(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "plan", "init", "Plan").strip())
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            assert run(*gate, "prepare", "shared", "--check", "true", "--when-ready").startswith("planned:")
            assert "No verifier is registered" in run(*post, "ready", "a", text="done a")
            candidate = json.loads((board / "verification.json").read_text())["candidate"]
            run(*post, "member", "v", "role=verifier")
            run(*post, "dispatch")
            request = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            assert request["to"] == ["v"] and request["text"].endswith("test %s v" % candidate), request
            assert json.loads((board / "verification.json").read_text())["candidate"] == candidate
            # Asked once: dispatching again posts nothing more.
            seq = request["seq"]
            assert "already holds" in run(*post, "dispatch")
            assert json.loads((board / "board.jsonl").read_text().splitlines()[-1])["seq"] == seq

    def test_the_commit_after_a_shared_accept_takes_the_verified_files_whatever_was_staged(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)

            def verified(check):
                board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Index")
                post = [sys.executable, SCRIPTS / "board.py", board]
                gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
                run(*post, "member", "w")
                run(*post, "member", "v", "role=verifier")
                run(*post, "ready", "w", text="done")
                cand = json.loads(run(*gate, "prepare", "shared", "--check", check))["candidate"]
                run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
                return gate, cand

            def landed(gate, cand):
                line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
                return subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj,
                                      check=True, capture_output=True, text=True).stdout

            # Staged, then edited (MM): the commit takes the bytes the check saw, not the staged ones.
            (proj / "file.txt").write_text("staged\n")
            g("add", "file.txt")
            (proj / "file.txt").write_text("checked\n")
            landed(*verified("grep -qx checked file.txt"))
            assert g("show", "HEAD:file.txt") == "checked" and g("status", "--porcelain") == ""

            # A deletion staged while the file is still there: the file stays, and there is nothing to commit.
            g("rm", "-q", "--cached", "file.txt")
            assert "Nothing to commit" in landed(*verified("test -f file.txt"))
            assert g("status", "--porcelain") == "" and g("ls-tree", "--name-only", "HEAD") == "file.txt"

            # A staged subset, beside a deletion left unstaged: both go into the commit.
            (proj / "new.txt").write_text("new\n")
            g("add", "new.txt")
            (proj / "file.txt").unlink()
            landed(*verified("test -f new.txt && test ! -e file.txt"))
            assert g("ls-tree", "--name-only", "HEAD") == "new.txt" and g("status", "--porcelain") == ""

            # A file a line-ending rule converts one way only: a fresh checkout would not bring back what the check read.
            g("config", "core.autocrlf", "input")
            (proj / "new.txt").write_bytes(b"dos\r\n")
            gate, cand = verified("test -s new.txt")
            line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
            turned = subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj,
                                    capture_output=True, text=True)
            assert turned.returncode and "a fresh checkout of the commit would not bring back new.txt" in turned.stderr, turned.stderr
            assert g("diff", "--cached", "--name-only") == "", "a refused commit leaves the index as it was"
            g("config", "--unset", "core.autocrlf")
            (proj / "new.txt").write_text("new\n")

            # Run data staged between the acceptance and the commit never reaches the commit.
            (proj / "new.txt").write_text("unix\n")
            gate, cand = verified("grep -qx unix new.txt")
            line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
            (proj / ".swarm" / "notes").write_text("mine")
            g("add", "-f", ".swarm/notes")
            late = subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj,
                                  capture_output=True, text=True)
            assert late.returncode and ".swarm/notes" in late.stderr, late.stderr
            g("reset", "-q", "--", ".swarm/notes")
            (proj / ".swarm" / "notes").unlink()
            landed(gate, cand)
            assert g("show", "--name-only", "--format=", "HEAD") == "new.txt"

            # A hook can reject the commit or change its private index, but it cannot land those changes.
            g("config", "core.hooksPath", ".commit-hooks")
            hook = proj / ".commit-hooks" / "pre-commit"
            hook.parent.mkdir()
            (proj / ".git" / "info").mkdir(exist_ok=True)
            (proj / ".git" / "info" / "exclude").write_text("/.commit-hooks/\n")
            hook.write_text("echo hooked > new.txt\ngit add new.txt\n")
            hook.chmod(0o755)
            (proj / "new.txt").write_text("newer\n")
            gate, cand = verified("grep -qx newer new.txt")
            line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
            changed = subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj,
                                     capture_output=True, text=True)
            assert changed.returncode and "changed the verified Git tree" in changed.stderr, changed.stderr
            assert g("show", "HEAD:new.txt") == "unix"
            assert g("diff", "--cached", "--name-only") == ""

            # An independent Git process can use the real index while the hook blocks. Its staging is preserved.
            (proj / "new.txt").write_text("newer\n")
            hook.write_text("#!/bin/sh\ntouch .swarm/hook-started\nwhile ! test -f .swarm/hook-release; do sleep .05; done\n")
            gate, cand = verified("grep -qx newer new.txt")
            run(*gate, "accept", cand)
            run(sys.executable, SCRIPTS / "board.py", gate[2], "read", "coordinator")
            run(sys.executable, SCRIPTS / "board.py", gate[2], "close")
            import time
            before = g("rev-parse", "HEAD")
            with subprocess.Popen([*gate, "commit", cand, "-m", "land"], cwd=proj,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
                deadline = time.monotonic() + 5
                try:
                    while not (proj / ".swarm" / "hook-started").exists() and time.monotonic() < deadline:
                        time.sleep(0.025)
                    assert (proj / ".swarm" / "hook-started").exists()
                    g("add", "new.txt")
                    # Force a different staged tree without changing any verified working-tree file.
                    g("update-index", "--chmod=+x", "new.txt")
                finally:
                    (proj / ".swarm" / "hook-release").touch()
                _, error = process.communicate(timeout=10)
                assert process.returncode and "the Git index or HEAD changed" in error, error
            assert g("rev-parse", "HEAD") == before
            assert g("diff", "--cached", "--summary") == "mode change 100644 => 100755 new.txt"
            g("reset", "-q", "--", "new.txt")
            assert "COMMITTED" in run(*gate, "commit", cand, "-m", "land after close")
            assert g("show", "HEAD:new.txt") == "newer" and g("status", "--porcelain") == ""

    def test_the_printed_staging_command_stages_exactly_what_was_verified(self):
        import re
        for sub in ("", "package"):
            with tempfile.TemporaryDirectory() as t:
                repo = Path(t).resolve()
                g = self._init_git(repo)
                proj = repo / sub
                (proj / ".swarm").mkdir(parents=True)
                (proj / ".swarm" / ".gitignore").write_text("integration-*\n")  # the project's own: run data shows in git status
                # a linked worktree inside the repository, under a name the shell must have quoted
                g("worktree", "add", "-q", "-b", "agent-x", str(repo / "agent work"))
                (repo / "agent work" / "scratch").write_text("work")
                post = gate = None

                def verified(check):
                    nonlocal post, gate
                    board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Stage")
                    post = [sys.executable, SCRIPTS / "board.py", board]
                    gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
                    run(*post, "member", "w")
                    run(*post, "member", "v", "role=verifier")
                    run(*post, "ready", "w", text="done")
                    cand = json.loads(run(*gate, "prepare", "shared", "--check", check))["candidate"]
                    run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
                    return cand

                def accepted(cand):
                    line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
                    assert line.endswith(" commit %s -m '<message>'" % cand), line
                    return line[len("Commit with: "):].replace("<message>", "land")

                def refused(cand):
                    result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
                    assert result.returncode, result.stdout
                    return result.stderr

                def staged():
                    return g("diff", "--cached", "--name-only").splitlines()

                # the verified change, outside the project's folder when the project is a subfolder
                (repo / "file.txt").write_text("v2")
                command = accepted(verified("grep -qx v2 %s/file.txt" % shlex.quote(str(repo))))
                swarm = (sub + "/" if sub else "") + ".swarm"
                assert any(name.startswith(swarm + "/") for name in g("status", "--porcelain", "--untracked-files=all").split())
                # the commit action stages exactly the verified file and commits it, from the project's folder
                subprocess.run(command, shell=True, cwd=proj, check=True, capture_output=True)
                assert g("show", "--name-only", "--format=", "HEAD").splitlines() == ["file.txt"]
                assert staged() == [], staged()
                (repo / "file.txt").write_text("v3")
                # run data or a linked worktree staged already is refused, naming the paths and how to unstage them
                g("reset", "-q")
                for extra in (swarm, "agent work"):
                    g("add", "-f", "--", extra)
                    cand = verified("grep -qx v3 %s/file.txt" % shlex.quote(str(repo)))
                    why = refused(cand)
                    assert "Swarm's run data or a linked worktree" in why and extra in why, why
                    remedy = re.search(r"Run `(git reset -q -- [^`]+)`", why)
                    subprocess.run(remedy[1], shell=True, cwd=proj, check=True, capture_output=True)
                    assert staged() == [], staged()
                    accepted(cand)

    # The review of the 0.3.47 audit fixes.

    def _verified(self, proj, check):
        """A new run in PROJ whose one worker is ready and whose shared candidate passed CHECK: (gate, candidate, run)."""
        board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Review")
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        run(*post, "ready", "w", text="done")
        cand = json.loads(run(*gate, "prepare", "shared", "--check", check))["candidate"]
        run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
        return gate, cand, Path(board)

    def test_shared_commit_round_trips_even_files_that_clean_to_the_parent_blob(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / ".gitattributes").write_text("file.txt filter=swarm-test\n")
            g("add", ".gitattributes")
            g("commit", "-m", "Configure fixture")
            g("config", "filter.swarm-test.clean", "head -c 2")
            (proj / "file.txt").write_text("v1 plus tested bytes")
            gate, cand, _ = self._verified(proj, "grep -qx 'v1 plus tested bytes' file.txt")
            run(*gate, "accept", cand)
            refused = subprocess.run([*gate, "commit", cand, "-m", "land"], capture_output=True, text=True)
            assert refused.returncode and "would not bring back file.txt" in refused.stderr, refused.stderr
            assert g("show", "HEAD:file.txt") == "v1"
            g("config", "filter.swarm-test.smudge", "printf 'v1 plus tested bytes'")
            assert "Nothing to commit" in run(*gate, "commit", cand, "-m", "land")

    def test_publication_reports_landed_commit_and_recovers_only_the_original_index(self):
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        import verify
        from unittest import mock
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            g("branch", "other")
            (proj / "file.txt").write_text("verified contents\n")
            gate, cand, board = self._verified(proj, "grep -qx 'verified contents' file.txt")
            run(*gate, "accept", cand)
            original = (proj / ".git/index").read_bytes()
            real_replace, real_git = os.replace, verify.git

            def replace(src, dest):
                if Path(src).name == "index.lock" and Path(dest) == proj / ".git/index":
                    raise OSError("injected index publication failure")
                return real_replace(src, dest)

            def git_at_publication(root, *args, **kwargs):
                if args[0] == "update-ref":
                    # Both branches start at the same commit. A supported checkout switch needs the index lock.
                    switched = subprocess.run(["git", "-C", str(root), "switch", "other"], capture_output=True, text=True)
                    assert switched.returncode and "index.lock" in switched.stderr, switched.stderr
                return real_git(root, *args, **kwargs)

            with mock.patch.object(verify.os, "replace", side_effect=replace), \
                 mock.patch.object(verify, "git", side_effect=git_at_publication):
                with self.assertRaisesRegex(ValueError, r"commit [a-f0-9]+ landed[\s\S]*recover-index"):
                    verify.commit(board, proj, cand, "land")
            revision = g("rev-parse", "HEAD")
            assert g("branch", "--show-current") == "main"
            assert g("show", "HEAD:file.txt") == "verified contents"
            assert (proj / ".git/index").read_bytes() == original
            (proj / "later.txt").write_text("keep my staging")
            g("add", "later.txt")
            result = subprocess.run([*gate, "recover-index", cand], capture_output=True, text=True)
            assert result.returncode and "index changed since publication" in result.stderr, result.stderr
            assert g("show", ":later.txt") == "keep my staging"
            (proj / ".git/index").write_bytes(original)
            assert f"RECOVERED INDEX {revision}" in run(*gate, "recover-index", cand)
            assert g("diff", "--cached", "--name-only") == ""

    def test_shared_accept_refuses_changes_inside_a_submodule(self):
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t:
            library, proj = Path(t_sub).resolve(), Path(t).resolve()
            self._init_git(library)
            g = self._init_git(proj)
            g("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
            g("commit", "-m", "add the library")
            lib = proj / "vendor" / "lib"
            for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
                g("config", *setting, cwd=lib)
            # an untracked file, then a tracked edit, inside the submodule: the verified bytes the commit cannot hold
            for inner in ("stray.txt", "file.txt"):
                (lib / inner).write_text("inner")
                gate, cand, _ = self._verified(proj, "test -s vendor/lib/%s" % inner)
                result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
                assert result.returncode and "submodule vendor/lib holds changes of its own" in result.stderr, (inner, result.stderr)
            # committed inside the submodule, its new commit is accepted, and the printed command stages it
            g("add", "-A", cwd=lib)
            g("commit", "-m", "inner", cwd=lib)
            gate, cand, _ = self._verified(proj, "test -s vendor/lib/stray.txt")
            g("add", "vendor/lib")  # its pointer staged before acceptance: no source changed, so the fingerprint holds
            line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
            subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj, check=True, capture_output=True)
            assert g("show", "--name-only", "--format=", "HEAD") == "vendor/lib"

    def test_shared_accept_refuses_a_repository_of_its_own_that_is_no_submodule(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            inner = proj / "vendor" / "tool"
            inner.mkdir(parents=True)
            self._init_git(inner)  # cloned or started inside the tree, never registered
            (inner / "edit.txt").write_text("uncommitted")
            gate, cand, _ = self._verified(proj, "test -s vendor/tool/edit.txt")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "vendor/tool/ is a Git repository of its own" in result.stderr, result.stderr
            # staged as a bare pointer, clean inside: still a repository no .gitmodules entry names
            subprocess.run(["git", "-C", str(inner), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(inner), "commit", "-qm", "inner"], check=True)
            subprocess.run(["git", "-C", str(proj), "add", "vendor/tool"], check=True, capture_output=True)
            gate, cand, _ = self._verified(proj, "test -s vendor/tool/edit.txt")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "vendor/tool is a Git repository of its own that no .gitmodules entry names" in result.stderr, result.stderr
            g("reset", "-q", "--", "vendor/tool")
            # ignored, it is no source and nothing stages it: a new candidate is accepted
            (proj / ".gitignore").write_text("vendor/\n")
            gate, cand, _ = self._verified(proj, "true")
            assert "ACCEPTED" in run(*gate, "accept", cand)

    def test_shared_accept_refuses_what_staging_leaves_out_of_a_submodule(self):
        import re
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t:
            library, proj = Path(t_sub).resolve(), Path(t).resolve()
            self._init_git(library)
            g = self._init_git(proj)
            g("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
            g("config", "-f", ".gitmodules", "submodule.vendor/lib.ignore", "all")
            g("add", ".gitmodules")
            g("commit", "-m", "add the library, its changes hidden from status")
            lib = proj / "vendor" / "lib"
            for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
                g("config", *setting, cwd=lib)

            def refused(check):
                gate, cand, _ = self._verified(proj, check)
                result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
                assert result.returncode, result.stdout
                return gate, cand, result.stderr

            # ignore = all hides even a dirty submodule from the parent's status: it is still refused
            (lib / "file.txt").write_text("edited")
            assert "holds changes of its own" in refused("grep -qx edited vendor/lib/file.txt")[2]
            # committed inside, its new commit is what the checks read, and `git add -A` would keep the old pointer
            g("commit", "-qam", "inner", cwd=lib)
            gate, cand, why = refused("grep -qx edited vendor/lib/file.txt")
            assert "leaves unstaged" in why and "vendor/lib" in why, why
            subprocess.run(re.search(r"Run `(git add -f -- [^`]+)`", why)[1], shell=True, cwd=proj, check=True, capture_output=True)
            assert "ACCEPTED" in run(*gate, "accept", cand)
            g("commit", "-m", "the new library")
            assert g("ls-tree", "HEAD", "vendor/lib").split()[2] == g("rev-parse", "HEAD", cwd=lib)
            # not checked out, a submodule's folder holds nothing the commit can take: files put there are refused
            g("submodule", "deinit", "-q", "-f", "vendor/lib")
            (lib / "dropped.txt").write_text("dropped")
            _, _, why = refused("test -s vendor/lib/dropped.txt")
            assert "vendor/lib is not checked out, yet files sit in its folder" in why, why
            (lib / "dropped.txt").unlink()
            gate, cand, _ = self._verified(proj, "true")
            assert "ACCEPTED" in run(*gate, "accept", cand)

    def test_shared_accept_refuses_a_committed_loose_pointer_once_it_moves_and_quotes_odd_paths(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            inner = proj / "tool"
            inner.mkdir()
            gi = self._init_git(inner)
            g("add", "tool")
            g("commit", "-m", "a pointer no .gitmodules entry backs")
            # committed and left alone, the commit after `accept` changes nothing about it
            gate, cand, _ = self._verified(proj, "true")
            assert "ACCEPTED" in run(*gate, "accept", cand)
            # moved, the commit would record the new pointer, which nobody else can resolve
            (inner / "more.txt").write_text("more")
            gi("add", "more.txt")
            gi("commit", "-m", "more")
            gate, cand, _ = self._verified(proj, "test -s tool/more.txt")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "tool is a Git repository of its own that no .gitmodules entry names" in result.stderr
            gi("reset", "-q", "--hard", "HEAD~1")
            # a path with a newline in it is quoted in a message, so it cannot break it or forge a line
            odd = proj / "odd\nACCEPTED x"
            odd.mkdir()
            self._init_git(odd)
            gate, cand, _ = self._verified(proj, "true")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and '"odd\\nACCEPTED x/" is a Git repository of its own' in result.stderr, result.stderr
            assert "\nACCEPTED" not in result.stderr

    def test_verify_refuses_malformed_input_naming_what_to_do(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Base")
            result = subprocess.run([sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "isolated", "--check", "true",
                                     "--base=--output=x"], capture_output=True, text=True)
            assert result.returncode and "--base takes a ref" in result.stderr, result.stderr
            # a candidate file cut short names what to do, not the field it lacks
            Path(board, "verification.json").write_text("{}")
            result = subprocess.run([sys.executable, SCRIPTS / "verify.py", board, proj, "accept", "c" * 16],
                                    capture_output=True, text=True)
            assert result.returncode and "superseded" in result.stderr, result.stderr

    def test_a_replacement_between_file_and_folder_fingerprints_alike_staged_or_not(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / "config").write_text("c")
            g("add", "config")
            g("commit", "-m", "config")
            # a tracked file replaced by a folder: staging it changes no byte, so no fingerprint either
            (proj / "config").unlink()
            (proj / "config").mkdir()
            (proj / "config" / "app.yml").write_text("a")
            unstaged = verify.source_digest(proj)
            g("add", "-A")
            assert verify.source_digest(proj) == unstaged
            g("commit", "-m", "folder")
            # and the mirror, a tracked folder replaced by a file
            (proj / "config" / "app.yml").unlink()
            (proj / "config").rmdir()
            (proj / "config").write_text("c")
            unstaged = verify.source_digest(proj)
            g("add", "-A")
            assert verify.source_digest(proj) == unstaged

    def test_shared_accept_sees_a_staged_rename_out_of_run_data(self):
        import re
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / ".swarm").mkdir()
            (proj / ".swarm" / "note.txt").write_text("note\n")
            g("add", "-f", ".swarm/note.txt")
            g("commit", "-m", "note")
            # a rename wholly within the source passes
            g("mv", "file.txt", "moved.txt")
            gate, cand, _ = self._verified(proj, "test -f moved.txt")
            run(*gate, "accept", cand)
            g("commit", "-m", "move")
            # a rename out of run data stages the deletion of run data, which rename detection would hide
            g("mv", ".swarm/note.txt", "notes.txt")
            gate, cand, _ = self._verified(proj, "test -f notes.txt")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and ".swarm/note.txt" in result.stderr, result.stderr
            remedy = re.search(r"Run `(git reset -q -- [^`]+)`", result.stderr)
            subprocess.run(remedy[1], shell=True, cwd=proj, check=True, capture_output=True)
            assert g("diff", "--cached", "--name-only", "--no-renames") == "notes.txt"
            run(*gate, "accept", cand)

    def test_shared_accept_prints_the_staging_command_without_asking_git_again(self):
        import contextlib
        import io
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            (proj / "file.txt").write_text("v2")
            gate, cand, board = self._verified(proj, "grep -qx v2 file.txt")
            real_git, real_save = verify.git, verify.save_candidate

            def save(directory, candidate):
                real_save(directory, candidate)
                if candidate.get("accepted"):  # Git fails from here on
                    verify.git = lambda *a, **k: (_ for _ in ()).throw(ValueError("git broke"))
            out = io.StringIO()
            try:
                verify.save_candidate = save
                with contextlib.redirect_stdout(out):
                    verify.accept(board, proj, cand)
            finally:
                verify.git, verify.save_candidate = real_git, real_save
            assert "Commit with: python3 " in out.getvalue(), out.getvalue()
            # a retry takes the already-accepted path, and names the command again
            assert " commit %s -m " % cand in run(*gate, "accept", cand)

    def test_a_late_verdict_answers_the_candidate_it_was_about(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Late"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier", "id=agent-v")
            run(*post, "member", "v2", "role=verifier")

            def table():
                return json.loads((board / "verification.json").read_text())

            def last():
                return json.loads(run(*post, "tail").splitlines()[-1])

            run(*post, "ready", "w", text="done")
            a = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*gate, "test", a, "v")  # tested, and no verdict posted on it yet
            run(*post, "ready", "w", text="fixed the tabs")  # the fix B is built on
            b = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "post", "coordinator", "@v please test candidate %s" % b)
            run(*post, "read", "v")  # it has read B's request
            run(*post, "post", "v2", "@coordinator " + run(*gate, "test", b, "v2").splitlines()[-1])
            # v's verdict on A, the candidate it tested, arrives after B replaced it
            out = run(*post, "post", "v", "@coordinator @w NOT PASSED: tabs are dropped")
            assert "answering candidate %s" % a in out, out
            late = last()
            assert late["candidate"] == a and late["rejects"] == [], late  # w's newer READY, the one B holds, stands
            assert table()["verified_by"] == "v2"  # B's pass is untouched
            # nor is B's review finished: a resumed run wakes v for it
            run(*post, "pause", "decision")
            run(*post, "resume")
            assert "@v " in last()["text"] and "v" in last()["to"], last()
            # a verdict on the candidate on the table still ends its review and withdraws its pass
            run(*post, "read", "v")
            run(*post, "post", "v", "@coordinator NOT VERIFIED: the check skips the tab case")
            assert last()["candidate"] == b and "verified_by" not in table()
            run(*gate, "accept", b, ok=False)
            run(*post, "post", "v2", "@coordinator " + run(*gate, "test", b, "v2").splitlines()[-1])
            # one naming a superseded candidate leaves the table alone, and so does acceptance
            run(*post, "post", "v", "@coordinator NOT VERIFIED %s: never mind" % a)
            assert last()["candidate"] == a and table()["verified_by"] == "v2"
            assert "ACCEPTED" in run(*gate, "accept", b)

    def test_a_piece_verdict_withdraws_the_report_its_verifier_read(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Piece"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")

            def last():
                return json.loads(run(*post, "tail").splitlines()[-1])

            run(*post, "ready", "w", text="done" + "\n" + ANSWERS)
            a = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "post", "coordinator", "@v please test candidate %s" % a)
            run(*post, "read", "v")
            run(*post, "post", "v", "@coordinator NOT VERIFIED %s: the check cannot run" % a)
            run(*post, "ready", "w", text="fixed" + "\n" + ANSWERS)
            run(*post, "read", "v")  # v has read w's new READY
            json.loads(run(*gate, "prepare", "shared", "--check", "true"))
            run(*post, "post", "coordinator", "@v please test the next candidate")  # not read yet
            # the request v read last names A, yet the NOT PASSED answers the READY it reviewed, which B holds
            run(*post, "post", "v", "@w NOT PASSED: still drops tabs")
            assert last()["candidate"] == a and last()["rejects"] == ["w"], last()
            run(*gate, "prepare", "shared", "--check", "true", ok=False)  # w is no longer ready
            # a READY v has not read is no work its verdict saw
            run(*post, "ready", "w", text="fixed again\n" + ANSWERS)
            json.loads(run(*gate, "prepare", "shared", "--check", "true"))
            run(*post, "post", "v", "@w NOT PASSED: the old build also leaked")
            assert last()["candidate"] == a and last()["rejects"] == [], last()
            json.loads(run(*gate, "prepare", "shared", "--check", "true"))  # w is still ready

    def test_a_verdict_naming_no_candidate_answers_the_one_its_verifier_tested_or_was_asked_to(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Bound"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            for verifier in ("v", "v2"):
                run(*post, "member", verifier, "role=verifier")

            def last():
                return json.loads(run(*post, "tail").splitlines()[-1])

            def tested(name):
                return json.loads((board / "members.json").read_text())["members"][name].get("tested")

            run(*post, "ready", "w", text="done")
            a = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            # a post that only mentions a candidate asks for no test: a later verdict is not bound to it
            run(*post, "post", "coordinator", "@v candidate %s is on the table, more soon" % a)
            run(*post, "read", "v")
            run(*post, "ready", "w", text="again")
            b = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "post", "v", "@coordinator NOT VERIFIED: the suite cannot start")
            assert last()["candidate"] == b, last()
            # v tests B; C replaces it; v2 passes C. v's rejection that names C leaves v's own test of B open
            run(*gate, "test", b, "v")
            assert tested("v") == b
            run(*post, "ready", "w", text="third")
            c = json.loads(run(*gate, "prepare", "shared", "--check", "true"))["candidate"]
            run(*post, "post", "v", "@coordinator NOT VERIFIED %s: named on purpose" % c)
            assert last()["candidate"] == c and tested("v") == b, (last(), tested("v"))
            run(*post, "post", "v2", "@coordinator " + run(*gate, "test", c, "v2").splitlines()[-1])
            # the verdict that names none answers B, the one v tested, and v2's pass of C stands
            run(*post, "post", "v", "@coordinator NOT VERIFIED: what I tested never built")
            assert last()["candidate"] == b and tested("v") is None, (last(), tested("v"))
            assert "ACCEPTED" in run(*gate, "accept", c)
            # once C is accepted, a verdict on B still answers B, and withdraws nothing C was made of
            run(*post, "post", "v", "@w NOT PASSED %s: the old build leaked" % b)
            assert last()["candidate"] == b and last()["rejects"] == [], last()
            assert "Already accepted" in run(*gate, "accept", c)

    def test_shared_accept_counts_only_a_registration_the_commit_will_hold(self):
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t:
            library, proj = Path(t_sub).resolve(), Path(t).resolve()
            self._init_git(library)
            g = self._init_git(proj)
            g("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
            # the pointer is staged, its registration is not: .gitmodules is untracked and ignored
            g("rm", "-q", "--cached", ".gitmodules")
            (proj / ".git" / "info" / "exclude").write_text(".gitmodules\n")
            gate, cand, _ = self._verified(proj, "true")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "vendor/lib is a Git repository of its own that no .gitmodules entry names" in result.stderr, result.stderr

    def test_checks_that_fill_in_a_submodule_of_an_isolated_candidate_do_not_pass(self):
        with tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t:
            library, proj = Path(t_sub).resolve(), Path(t).resolve()
            self._init_git(library)
            g = self._init_git(proj)
            g("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
            g("commit", "-q", "-m", "add the library")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Filled")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            g("switch", "-q", "-c", "work")
            (proj / "file.txt").write_text("v2")
            g("commit", "-q", "-am", "work")
            commit = g("rev-parse", "HEAD")
            g("switch", "-q", "main")
            run(*post, "ready", "w", commit, text="done")
            # the candidate's checkout has the submodule empty; a check fills it in and reads a file the landed commit will not bring
            check = "git -c protocol.file.allow=always submodule update --init -q vendor/lib && test -s vendor/lib/file.txt"
            cand = json.loads(run(*gate, "prepare", "isolated", "--check", check))["candidate"]
            result = subprocess.run([*gate, "test", cand, "v"], capture_output=True, text=True)
            assert result.returncode and "the checks changed files in the candidate's checkout" in result.stderr, (result.stdout, result.stderr)
            assert "VERIFIED" not in result.stdout
            # filled in by hand between prepare and test, the checkout is no longer the one prepared
            made = json.loads(run(*gate, "prepare", "isolated", "--check", "true"))
            subprocess.run(["git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q", "vendor/lib"],
                           cwd=made["path"], check=True, capture_output=True)
            result = subprocess.run([*gate, "test", made["candidate"], "v"], capture_output=True, text=True)
            assert result.returncode and "changed since it was prepared" in result.stderr, (result.stdout, result.stderr)

    def test_a_deinitialised_submodule_voids_a_shared_pass_that_read_it(self):
        sys.path.insert(0, str(SCRIPTS))
        import verify  # noqa: E402
        with tempfile.TemporaryDirectory() as t_inner, tempfile.TemporaryDirectory() as t_sub, tempfile.TemporaryDirectory() as t:
            inner, library, proj = Path(t_inner).resolve(), Path(t_sub).resolve(), Path(t).resolve()
            self._init_git(inner)
            gl = self._init_git(library)
            gl("-c", "protocol.file.allow=always", "submodule", "add", str(inner), "deps/inner")
            gl("commit", "-m", "add inner")
            g = self._init_git(proj)
            g("-c", "protocol.file.allow=always", "submodule", "add", str(library), "vendor/lib")
            g("commit", "-m", "add the library")
            g("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
            checked = verify.source_digest(proj)
            # the inner submodule of a clean checked-out one, deinitialised: its files are gone from the checks too
            g("-C", "vendor/lib", "submodule", "deinit", "-q", "-f", "deps/inner")
            assert verify.source_digest(proj) != checked
            # files dropped into it then are read by the checks, shown by no status, and held by no commit
            (proj / "vendor" / "lib" / "deps" / "inner" / "dropped.txt").write_text("dropped")
            gate, cand, _ = self._verified(proj, "test -s vendor/lib/deps/inner/dropped.txt")
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "vendor/lib/deps/inner is not checked out" in result.stderr, result.stderr
            (proj / "vendor" / "lib" / "deps" / "inner" / "dropped.txt").unlink()
            g("-C", "vendor/lib", "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init")
            assert verify.source_digest(proj) == checked
            gate, cand, _ = self._verified(proj, "test -s vendor/lib/file.txt")
            g("submodule", "deinit", "-q", "-f", "vendor/lib")  # the file the check read is gone
            result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
            assert result.returncode and "source files changed" in result.stderr, (result.stdout, result.stderr)
            # the isolated view is unchanged: an empty submodule and a clean checked-out one stand for one commit
            empty = verify.source_digest(proj, pointers=True)
            g("-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init")
            assert verify.source_digest(proj, pointers=True) == empty

    def test_an_accept_retry_runs_the_index_guards_again(self):
        import re
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / "file.txt").write_text("v2")
            (proj / "new.txt").write_text("new")
            gate, cand, _ = self._verified(proj, "grep -qx v2 file.txt && test -s new.txt")
            assert "ACCEPTED" in run(*gate, "accept", cand)

            def refused():
                result = subprocess.run([*gate, "accept", cand], capture_output=True, text=True)
                assert result.returncode and "Commit with" not in result.stdout, (result.stdout, result.stderr)
                return result.stderr

            # run data staged after the first acceptance: the fingerprint leaves it out, so only the guard sees it
            (proj / ".swarm" / "notes").write_text("mine")
            g("add", "-f", ".swarm/notes")
            why = refused()
            assert ".swarm/notes" in why, why
            subprocess.run(re.search(r"Run `(git reset -q -- [^`]+)`", why)[1], shell=True, cwd=proj, check=True)
            g("add", "file.txt")  # a staged subset is no matter: the commit action stages the verified files anew
            line = next(line for line in run(*gate, "accept", cand).splitlines() if line.startswith("Commit with: "))
            landing = line[len("Commit with: "):].replace("<message>", "land")
            # an edit after acceptance is not what passed: the commit action refuses it and commits nothing
            (proj / "file.txt").write_text("unread")
            late = subprocess.run(landing, shell=True, cwd=proj, capture_output=True, text=True)
            assert late.returncode and "source files changed after acceptance" in late.stderr, late.stderr
            assert g("log", "--format=%s", "-1") != "land"
            (proj / "file.txt").write_text("v2")
            # as verified, it commits exactly the verified files, whatever was staged meanwhile
            out = subprocess.run(landing, shell=True, cwd=proj, check=True, capture_output=True, text=True).stdout
            assert "COMMITTED " + cand in out, out
            assert g("show", "--name-only", "--format=", "HEAD").splitlines() == ["file.txt", "new.txt"]
            assert g("status", "--porcelain") == ""
            # a member's candidate that was never accepted, and a second commit, are refused
            again = subprocess.run(landing, shell=True, cwd=proj, capture_output=True, text=True)
            assert again.returncode, again.stdout

    # A check's output goes to a log under the run folder; the verifier sees a summary and a bounded tail.

    def _checked(self, proj, *checks, env=None):
        """A new run in PROJ whose one worker is ready, and a shared candidate of CHECKS tested once:
        (gate, prepared candidate, run, the test's result)."""
        board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "logs", "init", "Logs")
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        run(*post, "ready", "w", text="done")
        cand = json.loads(run(*gate, "prepare", "shared", *[arg for check in checks for arg in ("--check", check)]))
        result = subprocess.run([*gate, "test", cand["candidate"], "v"], capture_output=True, text=True, env=env)
        return gate, cand, Path(board), result

    def test_a_passing_check_shows_its_summary_and_tail_and_logs_everything(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            _, cand, board, result = self._checked(proj, 'seq 1 5000; echo "Ran 5000 tests OK"', "seq 1 20")
            assert result.returncode == 0, result.stderr
            log = board / "checks" / f"{cand['candidate']}-attempt01-check01.log"
            assert log.read_text() == "".join(f"{n}\n" for n in range(1, 5001)) + "Ran 5000 tests OK\n"
            lines = result.stdout.splitlines()
            assert lines[1].startswith("Exit 0 in ") and lines[1].endswith(f", 5001 lines (23911 bytes) of output, log: {log}"), lines[1]
            # the summary line and a few before it, and nothing more of the output
            assert lines[2:8] == ["4997", "4998", "4999", "5000", "Ran 5000 tests OK", "$ seq 1 20"], lines
            # a short pass is shown whole
            assert lines[8].startswith("Exit 0 in ") and ", 20 lines (51 bytes) of output, log: " in lines[8], lines[8]
            assert lines[9:-1] == [str(n) for n in range(1, 21)], lines
            assert lines[-1].startswith("VERIFIED "), lines

    def test_a_failing_check_shows_a_bounded_tail_and_the_log_holds_the_error(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            noisy = "printf 'FAIL: %s error\\n' decisive >&2; seq 1 20000; exit 1"
            wide = "for i in $(seq 1 100); do printf '%0200d\\n' $i; done; exit 4"
            _, cand, board, result = self._checked(proj, noisy, wide)
            assert result.returncode and "verification failed: " in result.stderr, result.stderr
            logs = board / "checks"
            first, second = (logs / f"{cand['candidate']}-attempt01-check0{n}.log" for n in (1, 2))
            assert first.read_text().startswith("FAIL: decisive error\n1\n")
            assert "FAIL: decisive error" not in result.stdout, result.stdout[:500]
            out = result.stdout.split("$ ")
            noisy_out, wide_out = out[1], out[2]
            assert f"Exit 1 in " in noisy_out and f", 20001 lines (108915 bytes) of output, log: {first}" in noisy_out
            assert "\n19941\n" in noisy_out and "\n19940\n" not in noisy_out and noisy_out.count("\n") < 70, noisy_out
            assert f"(the last 60 of 20001 lines; Grep the log for the rest, then Read the lines you need: {first})" in noisy_out
            # long lines are held to the byte limit, whole lines only
            assert f"Exit 4 in " in wide_out and str(second) in wide_out
            shown = [line for line in wide_out.splitlines() if len(line) == 200]
            assert 0 < len(shown) < 60 and shown[-1] == "%0200d" % 100 and len(wide_out) < 4000 + 1000, len(wide_out)
            assert f"(the last {len(shown)} of 100 lines; " in wide_out, wide_out[-300:]

    def test_a_checks_stderr_and_stdout_reach_its_log_in_order(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            _, cand, board, result = self._checked(proj, "echo one; echo two >&2; echo three; echo four >&2; exit 1")
            assert result.returncode
            log = board / "checks" / f"{cand['candidate']}-attempt01-check01.log"
            assert log.read_text() == "one\ntwo\nthree\nfour\n"
            assert "one\ntwo\nthree\nfour\n(the last 4 of 4 lines; " in result.stdout, result.stdout

    def test_a_timed_out_check_leaves_what_it_printed_in_its_log(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            (proj / "app.txt").write_text("ok")
            env = dict(os.environ, SWARM_VERIFY_TIMEOUT="0.5")
            _, cand, board, result = self._checked(proj, "echo before; echo also >&2; sleep 30", env=env)
            assert result.returncode and "timed out after 0.5s" in result.stderr, result.stderr
            log = board / "checks" / f"{cand['candidate']}-attempt01-check01.log"
            assert log.read_text() == "before\nalso\n"
            assert "Timed out after 0.5s in " in result.stdout and f"2 lines (12 bytes) of output, log: {log}" in result.stdout
            assert "before\nalso\n(the last 2 of 2 lines; " in result.stdout, result.stdout

    def test_a_timeout_reports_earlier_failures_and_runs_the_next_check(self):
        with tempfile.TemporaryDirectory() as t:
            env = dict(os.environ, SWARM_VERIFY_TIMEOUT="0.2")
            _, _, _, result = self._checked(Path(t).resolve(), "exit 7", "sleep 15", "echo ran-after-timeout", env=env)
            assert result.returncode and "exit 7; sleep 15 (timed out after 0.2s)" in result.stderr, result.stderr
            assert "Exit 0" in result.stdout and result.stdout.count("ran-after-timeout") == 2, result.stdout

    def test_output_is_bounded_and_an_overrun_is_a_failure(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            from unittest import mock
            with tempfile.TemporaryDirectory() as t, tempfile.TemporaryFile() as output:
                with mock.patch.object(verify, "MAX_CHECK_OUTPUT", 1 << 20):
                    with self.assertRaises(verify.CheckOutputLimit):
                        verify.run_check("head -c 2097152 /dev/zero", t, 10, output)
                assert output.tell() == 1 << 20
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_background_logging_does_not_extend_a_completed_check(self):
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        import verify
        with tempfile.TemporaryDirectory() as t, tempfile.TemporaryFile() as output:
            assert verify.run_check("yes background & printf 'foreground\\n'; exit 0", t, 0.5, output) == 0
            output.seek(0)
            assert b"foreground\n" in output.read()

    def test_checks_report_untracked_outputs_and_can_write_to_the_output_directory(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            _, _, _, result = self._checked(proj, "touch coverage.xml")
            assert result.returncode and "new untracked files: coverage.xml" in result.stderr, result.stderr
            assert "SWARM_VERIFY_OUTPUT_DIR" in result.stderr
            (proj / "coverage.xml").unlink()
            _, _, _, result = self._checked(proj, 'touch "$SWARM_VERIFY_OUTPUT_DIR/coverage.xml"')
            assert result.returncode == 0, result.stderr
            assert not (proj / "coverage.xml").exists()

    def test_logs_change_nothing_verification_records_or_accepts(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            source = proj / "file.txt"
            mtime = source.stat().st_mtime_ns
            source.write_text("v2")
            g("config", "core.trustctime", "false")
            # A same-size edit at the index timestamp must trigger Git's content check when using a private index.
            os.utime(source, ns=(mtime, mtime))
            os.utime(proj / ".git/index", ns=(mtime, mtime))
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "logs", "init", "Logs"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "cat file.txt; echo checked"))
            prepared = json.loads((board / "verification.json").read_text())
            first = run(*gate, "test", cand["candidate"], "v")
            again = run(*gate, "test", cand["candidate"], "v")
            # the line and the record are what they were: the attempt and the pass are all a test adds
            assert first.splitlines()[-1] == again.splitlines()[-1] == f"VERIFIED {cand['candidate']} {cand['digest']}", again
            tested = json.loads((board / "verification.json").read_text())
            assert {k: v for k, v in tested.items() if k not in ("attempt", "verified_by")} == prepared
            assert tested["verified_by"] == "v" and len(tested["attempt"]) == 32
            # one log per attempt, the earlier one kept
            assert sorted(log.name for log in (board / "checks").iterdir()) == [
                f"{cand['candidate']}-attempt01-check01.log", f"{cand['candidate']}-attempt02-check01.log"]
            # outside the fingerprint and out of the commit, even with nothing ignoring run data
            (proj / ".swarm" / ".gitignore").unlink()
            run(*post, "post", "v", "@coordinator " + again.splitlines()[-1])
            line = next(line for line in run(*gate, "accept", cand["candidate"]).splitlines() if line.startswith("Commit with: "))
            out = subprocess.run(line[len("Commit with: "):].replace("<message>", "land"), shell=True, cwd=proj,
                                 check=True, capture_output=True, text=True).stdout
            assert "COMMITTED " + cand["candidate"] in out, out
            assert g("show", "--name-only", "--format=", "HEAD").splitlines() == ["file.txt"]

    def test_two_attempts_that_count_alike_still_get_a_log_each(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            from unittest import mock
            with tempfile.TemporaryDirectory() as t:
                logs = Path(t)
                # both count the logs before either has made its own
                with mock.patch.object(Path, "glob", lambda *a, **k: iter(())):
                    first, second = verify.reserve(logs, "cand"), verify.reserve(logs, "cand")
                assert (first, second) == (1, 2), (first, second)
                assert sorted(p.name for p in logs.iterdir()) == ["cand-attempt01-check01.log", "cand-attempt02-check01.log"]
                assert verify.reserve(logs, "cand") == 3
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_logs_stay_out_of_an_isolated_candidate(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            _, _, board, post, gate = self._isolated_candidate(proj, lambda g: ((proj / "file.txt").write_text("v2"), g("add", "file.txt")))
            cand = json.loads(run(*gate, "prepare", "isolated", "--check", "cat file.txt"))
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            assert line == f"VERIFIED {cand['candidate']} {cand['commit']}"
            assert (Path(board) / "checks" / f"{cand['candidate']}-attempt01-check01.log").read_text() == "v2"
            run(*post, "post", "v", "@coordinator " + line)
            assert "ACCEPTED " in run(*gate, "accept", cand["candidate"])


class DiffHygiene(unittest.TestCase):
    """`prepare` refuses a candidate whose change has a mechanical defect its worker did not declare."""

    BIG = "".join(f"line {n}\n" for n in range(30))

    def _prepare(self, files, changes, report="done", mode="isolated", flags=(), keep=None):
        """The result of `prepare MODE FLAGS` for one worker that turned FILES into CHANGES (None deletes) and reported
        REPORT. The project is made in KEEP, when given, and left there."""
        with tempfile.TemporaryDirectory() as t:
            proj = Path(keep or t).resolve()

            def g(*args):
                return subprocess.run(["git", "-C", str(proj), *args], check=True, capture_output=True, text=True,
                                      env=NO_GIT_ENV).stdout.strip()
            g("init", "-b", "main")
            for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
                g("config", *setting)
            for name, content in files.items():
                (proj / name).parent.mkdir(parents=True, exist_ok=True)
                (proj / name).write_text(content)
            g("add", ".")
            g("commit", "-m", "init")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "hyg", "init", "Hygiene")
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            if mode == "isolated":
                g("switch", "-q", "-c", "work")
            for name, content in changes.items():
                (proj / name).unlink() if content is None else (proj / name).write_text(content)
            commit = []
            if mode == "isolated":
                g("add", "-A", "--", ":/", ":(exclude).swarm")
                g("commit", "-q", "-m", "work")
                commit = [g("rev-parse", "HEAD")]
                g("switch", "-q", "main")
            run(*post, "ready", "w", *commit, text=report)
            return subprocess.run([sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", mode, "--check", "true", *flags],
                                  capture_output=True, text=True)

    def test_a_whole_file_rewrite_is_refused_unless_declared(self):
        rewritten = "".join(f"other {n}\n" for n in range(15)) + self.BIG[self.BIG.index("line 15"):]
        for mode in ("isolated", "shared"):
            refused = self._prepare({"big.txt": self.BIG}, {"big.txt": rewritten}, mode=mode)
            assert refused.returncode and "big.txt lost 15 of its 30 lines (50%)" in refused.stderr, (mode, refused.stderr)
            declared = self._prepare({"big.txt": self.BIG}, {"big.txt": rewritten}, "done\nREWRITE: ./big.txt", mode)
            assert declared.returncode == 0, (mode, declared.stderr)
        # Another file's declaration is no blanket one, a small edit is no rewrite, and neither is a short file.
        other = self._prepare({"big.txt": self.BIG}, {"big.txt": rewritten}, "REWRITE: small.txt")
        assert other.returncode and "big.txt" in other.stderr, other.stderr
        edit = self._prepare({"big.txt": self.BIG}, {"big.txt": self.BIG.replace("line 3\n", "three\n")})
        assert edit.returncode == 0, edit.stderr
        short = self._prepare({"short.txt": "a\nb\nc\n"}, {"short.txt": "x\ny\nz\n"})
        assert short.returncode == 0, short.stderr
        # A file deleted or moved loses every line and is no rewrite.
        for mode in ("isolated", "shared"):
            assert self._prepare({"big.txt": self.BIG, "keep.txt": "k\n"}, {"big.txt": None}, mode=mode).returncode == 0, mode
            moved = self._prepare({"big.txt": self.BIG}, {"big.txt": None, "moved.txt": self.BIG}, mode=mode)
            assert moved.returncode == 0, (mode, moved.stderr)

    def test_a_lost_trailing_newline_is_refused(self):
        for mode in ("isolated", "shared"):
            refused = self._prepare({"a.txt": "one\ntwo\n"}, {"a.txt": "one\ntwo\nthree"}, mode=mode)
            assert refused.returncode and "a.txt lost the newline at its end" in refused.stderr, (mode, refused.stderr)
        for report, flags in (("NEWLINE: a.txt", ()), ("done", ("--allow", "newline:a.txt"))):  # meant, and said so
            assert self._prepare({"a.txt": "one\ntwo\n"}, {"a.txt": "one\ntwo\nthree"}, report, flags=flags).returncode == 0
        # A path with a space in it is declared and allowed whole; a declaration quoted in a pasted log is none.
        spaced = ({"with space.txt": "one\n"}, {"with space.txt": "one\ntwo"})
        assert self._prepare(*spaced, "NEWLINE: with space.txt").returncode == 0
        assert self._prepare(*spaced, flags=("--allow", "newline:with space.txt")).returncode == 0
        assert self._prepare(*spaced, "NEWLINE: with").returncode
        quoted = self._prepare({"a.txt": "one\n"}, {"a.txt": "one\ntwo"}, "the log:\n```\nNEWLINE: a.txt\n```")
        assert quoted.returncode and "a.txt lost the newline" in quoted.stderr, quoted.stderr
        kept = self._prepare({"a.txt": "one\ntwo"}, {"a.txt": "one\ntwo\nthree"})  # it never had one
        assert kept.returncode == 0, kept.stderr
        # A new file, a deleted one and a binary one have no newline to lose.
        other = self._prepare({"a.txt": "one\n", "b.bin": "x\0y\n", "gone.txt": "g\n"},
                              {"new.txt": "no newline", "b.bin": "x\0z", "gone.txt": None})
        assert other.returncode == 0, other.stderr

    def test_a_declaration_means_one_file_and_each_report_is_read_alone(self):
        files = {"cfg": "a\n", "cfg test.txt": "a\n"}
        refused = self._prepare(files, {"cfg": "b", "cfg test.txt": "b"}, "NEWLINE: cfg test.txt")
        assert refused.returncode and "cfg lost the newline" in refused.stderr and "cfg test.txt lost" not in refused.stderr, refused.stderr
        # A code fence the worker left open hides nothing of the coordinator's.
        allowed = self._prepare(files, {"cfg": "b"}, "done\n```\na log", flags=("--allow", "newline:cfg"))
        assert allowed.returncode == 0, allowed.stderr

    def test_formatting_mixed_with_real_changes_is_refused_unless_declared(self):
        files = {"a.ts": "if (x) {\n  y()\n}\n", "b.ts": "let n = 1\n", "c.py": "if x:\n    y()\n"}
        spaced = "if (x) {\n    y()\n}\n"
        for mode in ("isolated", "shared"):
            refused = self._prepare(files, {"a.ts": spaced, "b.ts": "let n = 2\n"}, mode=mode)
            assert refused.returncode and "a.ts changed in whitespace only" in refused.stderr and "b.ts" in refused.stderr, \
                (mode, refused.stderr)
        assert self._prepare(files, {"a.ts": spaced, "b.ts": "let n = 2\n"}, "REFORMAT: a.ts").returncode == 0
        assert self._prepare(files, {"a.ts": spaced}).returncode == 0  # formatting alone is one kind of change
        # A new file is a real change; indentation is meaning in Python, so a re-indent there is no formatting.
        new = self._prepare(files, {"a.ts": spaced, "new.ts": "let m = 1\n"}, mode="shared")
        assert new.returncode and "new.ts" in new.stderr, new.stderr
        assert self._prepare(files, {"c.py": "if x:\n  y()\n", "b.ts": "let n = 2\n"}).returncode == 0

    def test_a_removed_public_symbol_with_a_caller_left_is_refused_unless_declared(self):
        py = {"lib.py": "def helper():\n    return 1\n\n\ndef kept():\n    return 2\n", "app.py": "from lib import helper\nhelper()\n"}
        gone = {"lib.py": "def kept():\n    return 2\n"}
        for mode in ("isolated", "shared"):
            refused = self._prepare(py, gone, mode=mode)
            assert refused.returncode and 'app.py:1 still refers to "helper"' in refused.stderr, (mode, refused.stderr)
        assert self._prepare(py, gone, "REMOVED: helper").returncode == 0
        spaced = self._prepare({"mod dir/lib.py": py["lib.py"], "mod dir/app.py": py["app.py"]},
                               {"mod dir/lib.py": gone["lib.py"]}, mode="shared")
        assert spaced.returncode and 'mod dir/app.py:1 still refers to "helper"' in spaced.stderr, spaced.stderr
        # The coordinator's own override wakes no worker, and stays on the record for the verifier and the export.
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        allowed = self._prepare(py, gone, flags=("--allow", "removed:helper"), keep=temp.name)
        assert allowed.returncode == 0, allowed.stderr
        board = next((Path(temp.name) / ".swarm").glob("hyg-*"))
        cand = json.loads((board / "verification.json").read_text())
        assert cand["allowed"] == ["REMOVED: helper"], cand
        tested = run(sys.executable, SCRIPTS / "verify.py", board, temp.name, "test", cand["candidate"], "v")
        assert "Allowed by the coordinator at prepare, past the diff guards; name each in your report: REMOVED: helper" in tested
        assert "allowed these past the diff guards: REMOVED: helper." in Path(
            run(sys.executable, SCRIPTS / "board.py", board, "export")).read_text()
        for flags in (("--allow", "removed:other"), ("--allow", "callers:helper"), ("--allow", "removed:")):
            assert self._prepare(py, gone, flags=flags).returncode, flags
        assert self._prepare(py, {**gone, "app.py": "from lib import kept\nkept()\n"}).returncode == 0
        # Moved to another file, an import that still names the old module is broken, once and not for each line;
        # one that follows the move is fine, and so is a re-export left behind. A mention that imports nothing is no caller.
        there = {"other.py": "def helper():\n    return 1\n"}
        for mode in ("isolated", "shared"):
            moved = self._prepare(py, {**gone, **there}, mode=mode)
            assert moved.returncode and moved.stderr.count("app.py:") == 1, (mode, moved.stderr)
        assert self._prepare(py, {**gone, **there, "app.py": "from other import helper\nhelper()\n"}).returncode == 0
        assert self._prepare(py, {"lib.py": "from other import helper\n" + gone["lib.py"], **there}).returncode == 0
        # A mention left in the old module is no re-export: only an import or a binding of the name is.
        said = self._prepare(py, {"lib.py": "NAME = 'helper'\n" + gone["lib.py"], **there})
        assert said.returncode and "app.py:1" in said.stderr, said.stderr
        assert self._prepare(py, {"lib.py": "import other\nhelper = other.helper\n" + gone["lib.py"], **there}).returncode == 0
        # Imported under another name, the old module no longer gives out this one.
        named = self._prepare(py, {"lib.py": "from other import helper as other_helper\n" + gone["lib.py"], **there})
        assert named.returncode and "app.py:1" in named.stderr, named.stderr
        # A namesake another file already defines hides no importer of the removed one, and is itself no caller.
        twin = {**py, "twin.py": "def helper():\n    return 3\n", "use_twin.py": "from twin import helper\nhelper()\n"}
        refused = self._prepare(twin, gone)
        assert refused.returncode and "app.py:1" in refused.stderr and "use_twin.py" not in refused.stderr, refused.stderr
        assert self._prepare({**py, "app.py": "# helper is gone\nhelper = 3\n"}, gone).returncode == 0
        ts = {"lib.ts": "export function helper() {}\nexport const kept = 1\n", "app.ts": "import { helper } from './lib'\nhelper()\n"}
        refused = self._prepare(ts, {"lib.ts": "export const kept = 1\n"})
        assert refused.returncode and 'app.ts:1 still refers to "helper"' in refused.stderr, refused.stderr
        # The old module importing the moved symbol for its own use exports nothing; a re-export does.
        there = {"other.ts": "export function helper() {}\n"}
        inner = self._prepare(ts, {"lib.ts": "import { helper } from './other'\nexport const kept = helper\n", **there})
        assert inner.returncode and "app.ts:1" in inner.stderr, inner.stderr
        assert self._prepare(ts, {"lib.ts": "export { helper } from './other'\nexport const kept = 1\n", **there}).returncode == 0
        named = self._prepare(ts, {"lib.ts": "export { helper as other } from './other'\nexport const kept = 1\n", **there})
        assert named.returncode and "app.ts:1" in named.stderr, named.stderr
        # Removed from two modules, a namesake added elsewhere hides no importer of either.
        two = {**ts, "lib2.ts": "export function helper() {}\n", "app2.ts": "import { helper } from './lib2'\nhelper()\n"}
        both = self._prepare(two, {"lib.ts": "export const kept = 1\n", "lib2.ts": "export const two = 2\n", **there})
        assert both.returncode and "app.ts:1" in both.stderr and "app2.ts:1" in both.stderr, both.stderr
        # One module changes the symbol's signature and the other drops it: the importer of the other is still broken.
        kept = self._prepare(two, {"lib.ts": "export function helper(a: number) {}\nexport const kept = 1\n",
                                   "lib2.ts": "export const two = 2\n"})
        assert kept.returncode and "app2.ts:1" in kept.stderr and "app.ts:1" not in kept.stderr, kept.stderr

    def test_the_import_rules_read_the_shapes_they_were_written_for(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            diff = ("--- a/m.py\n+++ b/m.py\n-def gone(a):\n-    def inner(): pass\n-class Moved:\n+def gone(a, b):\n"
                    "--- a/x.ts\n+++ /dev/null\n-export default async function load() {}\n-  export const enum Kind { A }\n-const local = 1\n"
                    "--- /dev/null\n+++ b/y.py\n+class Moved:\n")
            assert verify.removed_public_symbols(diff) == {"load": ["x.ts"], "Kind": ["x.ts"]}
            for source, expected in (
                    ("from pkg.m import (\n    a,\n    sym as s,\n)\n", True), ("from pkg.m import *\n", True),
                    ("import pkg.m as mod\nmod.sym()\n", True), ("from pkg import m\nm.sym()\n", True),
                    ("import requests\nrequests.sym()\n", False), ("from other import *\nsym()\n", False),
                    ("# from m import sym\nsym = 1\n", False)):
                assert verify.imports_symbol("c.py", source, "sym", "pkg/m.py") is expected, source
            for source, expected in (
                    ("import { a, sym as b } from './m'\n", True), ("import type { sym } from './m'\n", True),
                    ("import sym from './m'\n", True), ("export { sym } from './m'\n", True),
                    ("import * as ns from './m'\nns.sym()\n", True), ("const { sym } = require('./m')\n", True),
                    ("const m = await import('./m')\nm?.sym()\n", True), ("require('./m').sym()\n", True),
                    ("// import { sym } from './m'\nconst sym = 1\n", False), ("import { symbol } from './m'\n", False),
                    ("export const other = 1\nconst sym = 2\nconst s = 'x from '\n", False)):
                assert verify.imports_symbol("c.ts", source, "sym", "m.ts") is expected, source
            assert verify.imports_symbol("c.ts", "import { sym } from '../lib/m.js'\n", "sym", "src/m.ts", True)
            assert not verify.imports_symbol("c.ts", "import { sym } from './other'\n", "sym", "src/m.ts", True)
            assert not verify.imports_symbol("c.py", "from other import sym\n", "sym", "pkg/m.py", True)
            assert verify.names_failure("FAILED tests/t.py::test_x") and not verify.names_failure("x " * 100000 + "ERROR")
            # Through a namespace, only the module the symbol left counts.
            assert verify.imports_symbol("c.ts", "import * as api from './m'\napi.sym()\n", "sym", "src/m.ts", True)
            assert not verify.imports_symbol("c.ts", "import * as api from './other'\napi.sym()\n", "sym", "src/m.ts", True)
            # index.* and __init__.py resolve against their module path when exact=True.
            for source, expected in (
                    ('import { login } from "./auth"\nlogin()\n', True),
                    ('import { login } from "./auth/index"\nlogin()\n', True),
                    ('import * as auth from "./auth"\nauth.login()\n', True),
                    ('import { login } from "./other"\nlogin()\n', False)):
                assert verify.imports_symbol("src/app.ts", source, "login", "src/auth/index.ts", True) is expected, source
            # Packages sharing a directory name (old/api vs new/api) must not be confused.
            assert not verify.imports_symbol("new/client.ts", 'import { formatLabel } from "./api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            assert not verify.imports_symbol("app/client.ts", 'import { formatLabel } from "../new/api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            assert verify.imports_symbol("old/client.ts", 'import { formatLabel } from "./api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            assert verify.imports_symbol("app/client.ts", 'import { formatLabel } from "../old/api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            # TS aliases and nested Python packages still match when not contradicting sibling paths.
            assert verify.imports_symbol("app/client.ts", 'import { formatLabel } from "@acme/api"\nformatLabel()\n', "formatLabel", "packages/ui/src/api/index.ts", True)
            assert verify.imports_symbol("app/client.ts", 'import { formatLabel } from "@/api"\nformatLabel()\n', "formatLabel", "src/api/index.ts", True)
            assert verify.imports_symbol("app/client.ts", 'import { formatLabel } from "@acme/old/api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            assert not verify.imports_symbol("app/client.ts", 'import { formatLabel } from "@acme/new/api"\nformatLabel()\n', "formatLabel", "old/api/index.ts", True)
            assert not verify.imports_symbol("new/client.py", "from .api import format_label\nformat_label()\n", "format_label", "old/api/__init__.py", True)
            assert not verify.imports_symbol("app.py", "from new.api import format_label\nformat_label()\n", "format_label", "old/api/__init__.py", True)
            assert verify.imports_symbol("old/client.py", "from .api import format_label\nformat_label()\n", "format_label", "old/api/__init__.py", True)
            assert verify.imports_symbol("app.py", "from old.api import format_label\nformat_label()\n", "format_label", "old/api/__init__.py", True)
            assert verify.imports_symbol("app.py", "from api import format_label\nformat_label()\n", "format_label", "backend/api/__init__.py", True)
            assert verify.imports_symbol("app.py", "from myproj.old.api import format_label\nformat_label()\n", "format_label", "old/api/__init__.py", True)
            for source, expected in (
                    ("from pkg import setup\nsetup()\n", True),
                    ("from pkg import *\nsetup()\n", True),
                    ("import pkg\npkg.setup()\n", True),
                    ("from other import setup\nsetup()\n", False)):
                assert verify.imports_symbol("app.py", source, "setup", "pkg/__init__.py", True) is expected, source
            # Each module a symbol left is kept; one that defines it again, with another signature, lost nothing.
            two = "--- a/a.ts\n+++ b/a.ts\n-export const h = 1\n%s--- a/b.ts\n+++ b/b.ts\n-export const h = 1\n"
            assert verify.removed_public_symbols(two % "") == {"h": ["a.ts", "b.ts"]}
            moved = {}
            assert verify.removed_public_symbols(two % "+export const h = 2\n", moved) == {} and moved == {"h": ["b.ts"]}
            moved = {}
            assert verify.removed_public_symbols("--- a/m.py\n+++ b/m.py\n-def go():\n--- /dev/null\n+++ b/n.py\n+def go():\n", moved) == {}
            assert moved == {"go": ["m.py"]}
            said = verify.declared("- REWRITE: src/a.py (the task asks for it)\nsee REWRITE: no.py", "```\nopen", "NEWLINE: cfg")
            assert said["REWRITE"] == {"src/a.py (the task asks for it"} and said["NEWLINE"] == {"cfg"}, said
            assert verify.meant(said["REWRITE"] | {"cfg test.txt", "b.py, see above"}, {"src/a.py", "cfg", "cfg test.txt", "b.py"}) == {
                "src/a.py", "cfg test.txt", "b.py"}
            assert verify.declared("REWRITE: ./a/b.py\n`REFORMAT: c.ts`\nREMOVED: Thing, REWRITE:\nnext") == {
                "REWRITE": {"a/b.py"}, "REFORMAT": {"c.ts"}, "REMOVED": {"Thing"}, "NEWLINE": set()}
            assert verify.declared("REMOVED: helper: unused\nREMOVED: `other`: legacy") == {
                "REWRITE": set(), "REFORMAT": set(), "REMOVED": {"helper", "other"}, "NEWLINE": set()}
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_removed_from_index_or_init_with_namesake_and_colon_reason_declared(self):
        def prepare_nested(files, changes, report="done"):
            with tempfile.TemporaryDirectory() as t:
                proj = Path(t).resolve()
                g = lambda *a: subprocess.run(["git", "-C", str(proj), *a], check=True, capture_output=True, text=True,
                                              env=NO_GIT_ENV).stdout.strip()
                g("init", "-b", "main")
                for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
                    g("config", *setting)
                for name, content in files.items():
                    (proj / name).parent.mkdir(parents=True, exist_ok=True)
                    (proj / name).write_text(content)
                g("add", ".")
                g("commit", "-m", "init")
                board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "hyg", "init", "Nested")
                post = [sys.executable, SCRIPTS / "board.py", board]
                run(*post, "member", "w")
                run(*post, "member", "v", "role=verifier")
                g("switch", "-q", "-c", "work")
                for name, content in changes.items():
                    (proj / name).write_text(content)
                g("add", "-A", "--", ":/", ":(exclude).swarm")
                g("commit", "-q", "-m", "work")
                commit = g("rev-parse", "HEAD")
                g("switch", "-q", "main")
                run(*post, "ready", "w", commit, text=report)
                return subprocess.run([sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "isolated", "--check", "true"],
                                      capture_output=True, text=True)

        ts = {
            "src/auth/index.ts": "export function login() {}\nexport const kept = 1\n",
            "src/other.ts": "export function login() {}\n",
            "app.ts": 'import { login } from "./src/auth"\nlogin()\n',
        }
        refused = prepare_nested(ts, {"src/auth/index.ts": "export const kept = 1\n"})
        assert refused.returncode and 'app.ts:1 still refers to "login"' in refused.stderr, refused.stderr
        assert prepare_nested(ts, {"src/auth/index.ts": "export const kept = 1\n"}, "REMOVED: login: replaced").returncode == 0
        py = {
            "pkg/__init__.py": "def setup():\n    return 1\n\ndef kept():\n    return 2\n",
            "other.py": "def setup():\n    return 3\n",
            "app.py": "from pkg import setup\nsetup()\n",
        }
        refused_py = prepare_nested(py, {"pkg/__init__.py": "def kept():\n    return 2\n"})
        assert refused_py.returncode and 'app.py:1 still refers to "setup"' in refused_py.stderr, refused_py.stderr
        assert prepare_nested(py, {"pkg/__init__.py": "def kept():\n    return 2\n"}, "REMOVED: setup: removed").returncode == 0
        # Removing formatLabel from old/api/index.ts must not flag a client importing from new/api/index.ts.
        sibling = {
            "old/api/index.ts": "export function formatLabel() { return 'old' }\nexport const kept = 1\n",
            "new/api/index.ts": "export function formatLabel() { return 'new' }\n",
            "client.ts": 'import { formatLabel } from "./new/api"\nformatLabel()\n',
        }
        assert prepare_nested(sibling, {"old/api/index.ts": "export const kept = 1\n"}).returncode == 0
        # Abbreviated flags like --time are rejected (allow_abbrev=False), aligning verify.py with guard.ts.
        abbrev = subprocess.run([sys.executable, SCRIPTS / "verify.py", "/nonexistent", "/nonexistent", "test", "--time", "60", "abc", "v"],
                                capture_output=True, text=True)
        assert abbrev.returncode != 0 and "unrecognized arguments: --time" in abbrev.stderr, abbrev.stderr


class BaselineDiff(unittest.TestCase):
    """`prepare --baseline-diff` waives a check that fails on the candidate's base in the same way, and nothing else."""

    def _test(self, before, after, *flags, mode="isolated", checks=("sh check.sh",), files=None, changes=None):
        """(the result of `test`, the candidate, the run) for a worker that turned check.sh from BEFORE into AFTER, in
        a project that also holds FILES and where the worker also wrote CHANGES; CHECKS are the candidate's."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        proj = Path(temp.name).resolve()

        def g(*args):
            return subprocess.run(["git", "-C", str(proj), *args], check=True, capture_output=True, text=True,
                                  env=NO_GIT_ENV).stdout.strip()
        g("init", "-b", "main")
        for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            g("config", *setting)
        (proj / "check.sh").write_text(before)
        for name, content in (files or {}).items():
            (proj / name).write_text(content)
        g("add", ".")
        g("commit", "-m", "init")
        board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "base", "init", "Baseline")
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        commit = []
        if mode == "isolated":
            g("switch", "-q", "-c", "work")
        (proj / "check.sh").write_text(after)
        (proj / "new.txt").write_text("new\n")
        for name, content in (changes or {}).items():
            (proj / name).write_text(content)
        if mode == "isolated":
            g("add", "check.sh", "new.txt", *(changes or {}))
            g("commit", "-q", "-m", "work")
            commit = [g("rev-parse", "HEAD")]
            g("switch", "-q", "main")
        run(*post, "ready", "w", *commit, text="done")
        prepared = subprocess.run([*gate, "prepare", mode, *(arg for check in checks for arg in ("--check", check)), *flags],
                                  capture_output=True, text=True)
        if prepared.returncode:
            return prepared, None, Path(board)
        cand = json.loads(prepared.stdout)["candidate"]
        return subprocess.run([*gate, "test", cand, "v"], capture_output=True, text=True), cand, Path(board)

    OLD = 'echo "in $(pwd)"\necho "FAILED tests/test_old.py::test_a - assert 1 == 2"\necho "1 failed, 3 passed in 0.52s"\nexit 1\n'

    def test_baseline_replays_only_completed_checks_before_a_timeout(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"SWARM_VERIFY_TIMEOUT": "0.5"}):
            result, _, board = self._test(self.OLD, self.OLD + "# candidate\n", "--baseline-diff",
                                         checks=("sh check.sh", "sleep 5", "echo 'FAILED later::check'; exit 1"))
        assert result.returncode and "timed out" in result.stderr, result.stderr
        assert "Waived" in result.stdout
        assert [log.name.split("-")[-2] for log in (board / "checks").glob("*-base.log")] == ["check01"]

    def test_a_failure_the_base_already_has_is_waived_and_said(self):
        # The same failure: the checkout's path, the duration and the count of passing tests are no part of it.
        same = self.OLD.replace("3 passed in 0.52s", "4 passed in 1.07s")
        result, cand, board = self._test(self.OLD, same, "--baseline-diff")
        assert result.returncode == 0 and "Waived" in result.stdout and "name each in your report: sh check.sh" in result.stdout, \
            (result.stdout, result.stderr)
        assert result.stdout.splitlines()[-1].startswith("VERIFIED " + cand)
        assert json.loads((board / "verification.json").read_text())["waived"] == ["sh check.sh"]
        assert not list(board.glob("baseline-*")) and list((board / "checks").glob("*-base.log"))
        # Asked for nothing, nothing is waived.
        result, _, _ = self._test(self.OLD, same)
        assert result.returncode and "verification failed: sh check.sh" in result.stderr and "Waived" not in result.stdout

    def test_a_clean_retry_keeps_no_waiver_of_the_attempt_before(self):
        flaky = 'test -n "$PASS_NOW" && exit 0\n' + self.OLD
        from unittest import mock
        with mock.patch.dict(os.environ):  # whatever the runner's environment holds, the first attempt fails
            os.environ.pop("PASS_NOW", None)
            result, cand, board = self._test(flaky, flaky + "# changed\n", "--baseline-diff")
        assert result.returncode == 0 and json.loads((board / "verification.json").read_text())["waived"] == ["sh check.sh"]
        again = subprocess.run([sys.executable, SCRIPTS / "verify.py", board, board.parent.parent, "test", cand, "v"],
                               capture_output=True, text=True, env={**os.environ, "PASS_NOW": "1"})
        assert again.returncode == 0 and "Waived" not in again.stdout, (again.stdout, again.stderr)
        assert "waived" not in json.loads((board / "verification.json").read_text())

    def test_a_new_failure_beside_the_old_one_is_not_waived(self):
        more = self.OLD.replace("exit 1", 'echo "FAILED tests/test_new.py::test_b"\nexit 1')
        result, _, _ = self._test(self.OLD, more, "--baseline-diff")
        assert result.returncode and "Not waived: it fails on the base" in result.stdout and "other output" in result.stdout, result.stdout
        result, _, _ = self._test("exit 0\n", self.OLD, "--baseline-diff")
        assert result.returncode and "Not waived: it passes on the base" in result.stdout, result.stdout

    def test_only_the_same_failure_with_the_same_setup_is_waived(self):
        # What an earlier check sets up is there on the base too: without it the base would fail for want of the fixture.
        reads = 'cat fixture.txt || exit 1\necho "FAILED tests/test_old.py::test_a"\nexit 1\n'
        result, _, _ = self._test(reads, reads, "--baseline-diff", checks=("echo data > fixture.txt", "sh check.sh"),
                                  files={".gitignore": "fixture.txt\n"})
        assert result.returncode == 0 and "Waived" in result.stdout, (result.stdout, result.stderr)
        # A setup that works here and not on the base leaves the two runs set up differently.
        result, _, _ = self._test(self.OLD, self.OLD, "--baseline-diff", checks=("test -f new.txt", "sh check.sh"))
        assert result.returncode and "Not waived: an earlier check ends or prints otherwise on the base" in result.stdout, result.stdout
        # The same exit and other output is another setup too.
        result, _, _ = self._test(self.OLD, self.OLD, "--baseline-diff", checks=("cat new.txt 2>/dev/null; echo set up", "sh check.sh"))
        assert result.returncode and "Not waived: an earlier check ends or prints otherwise on the base" in result.stdout, result.stdout
        # Counts name no failure: one failed test of two may be another one.
        counts = 'echo "1 failed, 1 passed in 0.10s"\nexit 1\n'
        result, _, _ = self._test(counts, counts + "# changed\n", "--baseline-diff")
        assert result.returncode and "Not waived: it prints nothing that names a failure" in result.stdout, result.stdout
        # A banner, an error that names no test, and the path of a log: none says which test failed.
        for said in ("", 'echo "make: *** [test] Error 1"\n', 'echo "error logs saved in reports/check.log"\n'):
            banner = 'echo "Running unit tests"\necho "1 failed, 1 passed"\n' + said + 'exit 1\n'
            result, _, _ = self._test(banner, banner + "# changed\n", "--baseline-diff")
            assert result.returncode and "Not waived: it prints nothing that names a failure" in result.stdout, result.stdout
        # Progress marks alone name no failure.
        marks = 'echo "..F [100%]"\nexit 1\n'
        result, _, _ = self._test(marks, marks + "# changed\n", "--baseline-diff")
        assert result.returncode and "Not waived: it prints nothing that names a failure" in result.stdout, result.stdout
        # Another exit code, or nothing printed on either side, shows no same failure.
        result, _, _ = self._test("exit 1\n", "exit 2\n", "--baseline-diff")
        assert result.returncode and "Not waived: it exits 1 on the base" in result.stdout and "and 2 here" in result.stdout, result.stdout
        result, _, _ = self._test("exit 1\n", "exit 1\n# changed\n", "--baseline-diff")
        assert result.returncode and "Not waived: it prints nothing that names a failure" in result.stdout, result.stdout
        # A dependency list under a name of the project's own changes what the base runs with.
        result, _, _ = self._test(self.OLD, self.OLD, "--baseline-diff", files={"requirements-dev.txt": "a\n"},
                                  changes={"requirements-dev.txt": "a\nb\n"})
        assert result.returncode and "Not waived: the candidate changes requirements-dev.txt" in result.stdout, result.stdout
        result, _, _ = self._test(self.OLD, self.OLD, "--baseline-diff", files={".npmrc": "a\n"}, changes={".npmrc": "b\n"})
        assert result.returncode and "Not waived: the candidate changes .npmrc" in result.stdout, result.stdout

    def test_the_base_is_asked_only_after_every_check_ran_here(self):
        # The replay of an earlier check on the base writes the marker again: a later check here must not read that.
        with tempfile.TemporaryDirectory() as outside:
            marker = os.path.join(os.path.realpath(outside), "marker")
            result, _, _ = self._test(self.OLD, self.OLD + "# changed\n", "--baseline-diff", checks=(
                "echo run >> " + marker, "sh check.sh", 'test "$(wc -l < %s)" -eq 1' % marker))
        assert result.returncode == 0 and "Waived" in result.stdout, (result.stdout, result.stderr)

    def test_the_base_runs_each_check_once_an_attempt(self):
        with tempfile.TemporaryDirectory() as outside:
            marker = os.path.join(os.path.realpath(outside), "runs")
            checks = tuple('echo x >> %s; echo "FAILED tests/t.py::test_%d"; exit 1' % (marker, n) for n in range(3))
            result, _, _ = self._test(self.OLD, self.OLD + "# changed\n", "--baseline-diff", checks=checks)
            assert result.returncode == 0 and result.stdout.count("Waived, as") == 3, (result.stdout, result.stderr)
            with open(marker) as f:
                assert len(f.readlines()) == 6  # three here, three on the base

    def test_a_check_that_could_not_run_is_never_waived(self):
        broken = 'echo "ModuleNotFoundError: No module named \'requests\'"\nexit 1\n'
        result, _, board = self._test(broken, broken, "--baseline-diff")
        assert result.returncode and "Not waived: the check could not run here" in result.stdout, result.stdout
        assert not list((board / "checks").glob("*-base.log"))  # the base was not even asked
        missing = 'echo "sh: line 1: mytool: command not found"\nexit 127\n'  # the shell's own code for it
        result, _, _ = self._test(missing, missing, "--baseline-diff")
        assert result.returncode and "Not waived: the check could not run here" in result.stdout, result.stdout
        wrapped = './tools/missing-tool || exit 1\n'  # the command around it gives its own exit code
        result, _, _ = self._test(wrapped, wrapped + "# changed\n", "--baseline-diff")
        assert result.returncode and "Not waived: the check could not run here" in result.stdout, result.stdout
        refused, _, _ = self._test(self.OLD, self.OLD, "--baseline-diff", mode="shared")
        assert refused.returncode and "--baseline-diff is for an isolated candidate" in refused.stderr, refused.stderr

    def test_the_fingerprint_keeps_what_names_a_failure(self):
        sys.path.insert(0, str(SCRIPTS))
        try:
            import verify
            def run_output(root, seconds, passed, order):
                blocks = ["_________ test_a _________\nassert 1 == 2\n", "_________ test_b _________\nassert x\n"]
                return ("\x1b[31m....F.F [ 50%]\x1b[0m\n=================== FAILURES ===================\n" + "".join(blocks[::order])
                        + "=========== short test summary info ===========\n"
                        + "\n".join(["FAILED %s/t.py::test_a [gw1]" % root, "FAILED %s/t.py::test_b [gw0]" % root][::order])
                        + "\n========= 2 failed, %d passed in %ss =========\n" % (passed, seconds))
            one = verify.normalized_failure(run_output("/tmp/head", "1.20", 7, 1), ["/tmp/head", "/tmp/base"])
            assert one == verify.normalized_failure(run_output("/tmp/base", "0.31", 9, -1), ["/tmp/head", "/tmp/base"])
            assert "<ROOT>/t.py::test_a" in one and "2 failed, <N> passed in <DURATION>" in one
            assert one != verify.normalized_failure(run_output("/tmp/base", "0.31", 9, 1).replace("assert x", "assert y"), ["/tmp/base"])
            assert one != verify.normalized_failure(run_output("/tmp/base", "0.31", 9, 1).replace("2 failed", "3 failed"), ["/tmp/base"])
            assert verify.environment_failure("bash: command not found: pytest") and not verify.environment_failure("TypeError: Failed to fetch")
            # Parallel pytest output without warnings or short-summary sections still normalizes identically.
            def bare_pytest(root, seconds, passed, order):
                blocks = ["_________ test_a _________\nassert 1 == 2\n", "_________ test_b _________\nassert x\n"]
                return ("=================== FAILURES ===================\n" + "".join(blocks[::order])
                        + "========= 2 failed, %d passed in %ss =========\n" % (passed, seconds))
            bare_one = verify.normalized_failure(bare_pytest("/tmp/head", "1.20", 7, 1), ["/tmp/head", "/tmp/base"])
            assert bare_one == verify.normalized_failure(bare_pytest("/tmp/base", "0.31", 9, -1), ["/tmp/head", "/tmp/base"])
            assert bare_one != verify.normalized_failure(bare_pytest("/tmp/base", "0.31", 9, -1).replace("assert x", "assert y"), ["/tmp/base"])
        finally:
            sys.path.remove(str(SCRIPTS))

    def test_stale_baseline_dir_does_not_block_baseline_diff_retry(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        proj = Path(temp.name).resolve()

        def g(*args):
            return subprocess.run(["git", "-C", str(proj), *args], check=True, capture_output=True, text=True,
                                  env=NO_GIT_ENV).stdout.strip()

        g("init", "-b", "main")
        for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            g("config", *setting)
        (proj / "check.sh").write_text(self.OLD)
        g("add", ".")
        g("commit", "-m", "init")
        board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "base", "init", "StaleBaseline"))
        post = [sys.executable, SCRIPTS / "board.py", board]
        gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        g("switch", "-q", "-c", "work")
        (proj / "new.txt").write_text("new\n")
        g("add", "new.txt")
        g("commit", "-q", "-m", "work")
        commit = g("rev-parse", "HEAD")
        g("switch", "-q", "main")
        run(*post, "ready", "w", commit, text="done")
        cand = json.loads(run(*gate, "prepare", "isolated", "--check", "sh check.sh", "--baseline-diff"))["candidate"]
        (board / f"baseline-{cand}").mkdir()
        (board / f"baseline-{cand}" / "leftover").write_text("stale\n")
        result = subprocess.run([*gate, "test", cand, "v"], capture_output=True, text=True)
        assert result.returncode == 0 and result.stdout.splitlines()[-1].startswith("VERIFIED " + cand), (result.stdout, result.stderr)
        assert list(board.glob("baseline-*")) == [board / f"baseline-{cand}"]


class AnalysisGaps(unittest.TestCase):
    """Cases the diff analysis and the check runner once got wrong."""

    def setUp(self):
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        import verify
        self.verify = verify

    def _prepare(self, files, changes):
        """`prepare isolated` for one worker that turned FILES into CHANGES."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        proj = Path(temp.name).resolve()

        def g(*args):
            return subprocess.run(["git", "-C", str(proj), *args], check=True, capture_output=True, text=True,
                                  env=NO_GIT_ENV).stdout.strip()
        g("init", "-b", "main")
        for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            g("config", *setting)
        for name, content in files.items():
            (proj / name).parent.mkdir(parents=True, exist_ok=True)
            (proj / name).write_text(content)
        g("add", ".")
        g("commit", "-m", "init")
        board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "gap", "init", "Gaps")
        post = [sys.executable, SCRIPTS / "board.py", board]
        run(*post, "member", "w")
        run(*post, "member", "v", "role=verifier")
        g("switch", "-q", "-c", "work")
        for name, content in changes.items():
            (proj / name).write_text(content)
        g("add", "-A", "--", ":/", ":(exclude).swarm")
        g("commit", "-q", "-m", "work")
        commit = g("rev-parse", "HEAD")
        g("switch", "-q", "main")
        run(*post, "ready", "w", commit, text="done")
        return subprocess.run([sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "isolated", "--check", "true"],
                              capture_output=True, text=True)

    def test_a_definition_replaced_by_an_alias_or_a_re_export_keeps_its_callers(self):
        py = {"lib.py": "def helper():\n    return 1\n", "app.py": "from lib import helper\nhelper()\n"}
        aliased = self._prepare(py, {"lib.py": "def new_helper():\n    return 1\n\n\nhelper = new_helper\n"})
        assert aliased.returncode == 0, aliased.stderr
        ts = {"lib.ts": "export function helper() {}\n", "app.ts": "import { helper } from './lib'\nhelper()\n"}
        exported = self._prepare(ts, {"lib.ts": "export function newHelper() {}\nexport { newHelper as helper }\n"})
        assert exported.returncode == 0, exported.stderr
        gone = self._prepare(ts, {"lib.ts": "export function newHelper() {}\n"})
        assert gone.returncode and 'app.ts:1 still refers to "helper"' in gone.stderr, gone.stderr

    def test_a_nested_import_or_export_is_no_re_export(self):
        py = {"lib.py": "def helper():\n    return 1\n", "app.py": "from lib import helper\nhelper()\n"}
        nested = self._prepare(py, {"lib.py": "def run():\n    from other import helper\n    return helper()\n",
                                    "other.py": "def helper():\n    return 1\n"})
        assert nested.returncode and 'app.py:1 still refers to "helper"' in nested.stderr, nested.stderr
        ts = {"lib.ts": "export function helper() {}\n", "app.ts": "import { helper } from './lib'\nhelper()\n"}
        ambient = self._prepare(ts, {"lib.ts": "export function newHelper() {}\ndeclare module 'x' {\n  export { helper } from './other'\n}\n"})
        assert ambient.returncode and 'app.ts:1 still refers to "helper"' in ambient.stderr, ambient.stderr

    def test_a_removed_line_that_looks_like_a_patch_header_is_a_removed_line(self):
        diff = ("diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n@@ -1,3 +0,0 @@\n--- /dev/null\n-export const gone = 1\n"
                "--- a/other.ts\n-export const lost = 1\n@@ -9 +7 @@\n+++ b/other.ts\n+export const lost = 2\n")
        assert self.verify.removed_public_symbols(diff) == {"gone": ["m.ts"]}

    def test_output_left_in_the_pipe_after_exit_still_counts_toward_the_limit(self):
        from unittest import mock
        process = subprocess.Popen(["/bin/sh", "-c", "head -c 1000 /dev/zero"], stdout=subprocess.PIPE, start_new_session=True)
        self.addCleanup(process.stdout.close)
        process.wait()
        # check_output's cleanup ignores these signals; run_check's finally would restore them.
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            self.addCleanup(signal.signal, number, signal.getsignal(number))
        with tempfile.TemporaryFile() as output, mock.patch.object(self.verify, "MAX_CHECK_OUTPUT", 100):
            with self.assertRaises(self.verify.CheckOutputLimit):
                self.verify.check_output(process, "head", 10, output)
            assert output.tell() == 100

    def test_a_parenthesized_import_reads_past_a_parenthesis_in_a_comment(self):
        source = "from pkg.m import (  # the old (v1) names\n    a,  # see (x)\n    sym,\n)\n"
        assert self.verify.imports_symbol("c.py", source, "sym", "pkg/m.py")
        assert not self.verify.imports_symbol("c.py", "from pkg.m import (\n    a,  # not sym\n)\n", "sym", "pkg/m.py")
        py = {"lib.py": "def helper():\n    return 1\n", "app.py": "from lib import helper\nhelper()\n"}
        kept = self._prepare(py, {"lib.py": "from other import (  # moved (see other)\n    helper,\n)\n",
                                  "other.py": "def helper():\n    return 1\n"})
        assert kept.returncode == 0, kept.stderr
        # A name in a comment is no re-export.
        said = self._prepare(py, {"lib.py": "from other import (\n    other_thing,  # was helper\n)\n",
                                  "other.py": "def helper():\n    return 1\n\n\nother_thing = 1\n"})
        assert said.returncode and "app.py:1" in said.stderr, said.stderr

    def test_a_base_run_over_the_output_limit_is_not_called_a_timeout(self):
        result, _, _ = BaselineDiff._test(self, "head -c 17000000 /dev/zero\nexit 1\n", BaselineDiff.OLD, "--baseline-diff")
        assert result.returncode and "Not waived" in result.stdout, (result.stdout, result.stderr)
        assert "timed out" not in result.stdout and "more than a check may print" in result.stdout, result.stdout

    def test_a_baseline_worktree_git_could_not_add_leaves_no_record(self):
        from unittest import mock
        verify = self.verify
        with tempfile.TemporaryDirectory() as t:
            board = Path(t)
            log = board / "check.log"
            log.write_text("FAILED tests/t.py::test_x\n")

            def git(path, *args, **_):
                if args[:2] == ("worktree", "add"):
                    raise ValueError("fatal: cannot add")
                return b""
            candidate = {"worktree": t, "base": "0" * 40, "commit": "1" * 40, "candidate": "c1", "path": t}
            with mock.patch.object(verify, "git", git):
                verdicts = verify.same_on_base(board, board, candidate, [("false", 1, log)], 10, verify.time.monotonic() + 10, board)
            assert verdicts == {0: (False, "the base could not be checked: fatal: cannot add")}, verdicts
            assert not (board / verify.BASELINES_FILE).exists()


class LandingDataLoss(unittest.TestCase):
    """What lands, or is cleaned up, is what was verified, and nothing of the user's is lost on the way."""

    _init_git = VerifyRegressions._init_git
    _verified = VerifyRegressions._verified
    _isolated_candidate = VerifyRegressions._isolated_candidate

    def test_shared_commit_lands_when_the_project_ignores_its_run_data(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / ".gitignore").write_text(".swarm/\n")
            g("add", ".gitignore")
            g("commit", "-m", "Ignore run data")
            (proj / "file.txt").write_text("v2")
            gate, cand, _ = self._verified(proj, "grep -qx v2 file.txt")
            run(*gate, "accept", cand)
            assert "COMMITTED" in run(*gate, "commit", cand, "-m", "land")
            assert g("show", "HEAD:file.txt") == "v2" and g("ls-tree", "-r", "--name-only", "HEAD", ".swarm") == ""

    def test_shared_commit_refuses_to_drop_an_executable_bit_the_checks_relied_on(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            g("config", "core.filemode", "false")
            script = proj / "run.sh"
            script.write_text("#!/bin/sh\nexit 1\n")
            # An untouched file whose bit differs from the index is no part of this commit and blocks nothing.
            stray = proj / "stray.txt"
            stray.write_text("old\n")
            g("add", "run.sh", "stray.txt")
            g("commit", "-m", "Add script")
            stray.chmod(0o755)
            base = g("rev-parse", "HEAD")
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o755)
            gate, cand, _ = self._verified(proj, "./run.sh")
            run(*gate, "accept", cand)
            refused = subprocess.run([*gate, "commit", cand, "-m", "land"], capture_output=True, text=True)
            assert refused.returncode and "run.sh" in refused.stderr and "--chmod=+x" in refused.stderr, refused.stderr
            assert "stray.txt" not in refused.stderr, refused.stderr
            assert g("rev-parse", "HEAD") == base
            g("add", "--chmod=+x", "--", "run.sh")
            assert "COMMITTED" in run(*gate, "commit", cand, "-m", "land")
            assert g("ls-tree", "HEAD", "run.sh").startswith("100755 ")

    def test_shared_commit_refuses_to_drop_a_bit_set_during_the_run_on_an_unchanged_file(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            g("config", "core.filemode", "false")
            script = proj / "runner.sh"
            script.write_text("#!/bin/sh\nexit 0\n")
            stray = proj / "stray.txt"
            stray.write_text("old\n")
            g("add", "runner.sh", "stray.txt")
            g("commit", "-m", "Add script")
            stray.chmod(0o755)  # before the run: no part of its work
            time.sleep(0.05)
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Review")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            time.sleep(0.05)
            # The run's work: the script made executable, its contents untouched, and another file edited. The stray
            # file is rewritten as it was: its bit still differs as it did before the run, and is no part of the work.
            stray.write_text("old\n")
            script.chmod(0o755)
            (proj / "file.txt").write_text("v2")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -x runner.sh"))["candidate"]
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
            run(*gate, "accept", cand)
            base = g("rev-parse", "HEAD")
            refused = subprocess.run([*gate, "commit", cand, "-m", "land"], capture_output=True, text=True)
            assert refused.returncode and "runner.sh" in refused.stderr and "--chmod=+x" in refused.stderr, refused.stderr
            assert "stray.txt" not in refused.stderr, refused.stderr
            assert g("rev-parse", "HEAD") == base
            g("add", "--chmod=+x", "--", "runner.sh")
            assert "COMMITTED" in run(*gate, "commit", cand, "-m", "land")
            assert g("ls-tree", "HEAD", "runner.sh").startswith("100755 ")

    def test_shared_commit_holds_every_bit_to_the_checks_when_init_recorded_no_baseline(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            g("config", "core.filemode", "false")
            script = proj / "runner.sh"
            script.write_text("#!/bin/sh\nexit 0\n")
            g("add", "runner.sh")
            g("commit", "-m", "Add script")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Review")
            state = json.loads((Path(board) / "members.json").read_text())
            state["mode_drift"] = "unknown"  # as init leaves it when git could not list the modes
            (Path(board) / "members.json").write_text(json.dumps(state))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            script.chmod(0o755)  # the run's work: the bit alone, and another file
            (proj / "file.txt").write_text("v2")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test -x runner.sh"))["candidate"]
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
            run(*gate, "accept", cand)
            refused = subprocess.run([*gate, "commit", cand, "-m", "land"], capture_output=True, text=True)
            assert refused.returncode and "runner.sh" in refused.stderr and "could not record" in refused.stderr, refused.stderr

    def test_shared_commit_refuses_a_bit_the_run_turned_back_against_a_new_index_mode(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            g("config", "core.filemode", "false")
            script = proj / "runner.sh"
            script.write_text("#!/bin/sh\nexit 0\n")
            g("add", "runner.sh")
            g("commit", "-m", "Add script")
            script.chmod(0o755)  # differs from Git's 100644 before the run: recorded at init as that difference
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Review")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            # The run stages +x and commits it, then takes the bit off again, the contents as they were.
            g("add", "--chmod=+x", "--", "runner.sh")
            g("commit", "-m", "Make it executable")
            script.chmod(0o644)
            (proj / "file.txt").write_text("v2")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "test ! -x runner.sh"))["candidate"]
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", cand, "v").splitlines()[-1])
            run(*gate, "accept", cand)
            refused = subprocess.run([*gate, "commit", cand, "-m", "land"], capture_output=True, text=True)
            assert refused.returncode and "runner.sh" in refused.stderr and "--chmod=-x" in refused.stderr, refused.stderr

    def test_isolated_prepare_refuses_a_checkout_a_hook_left_unlike_its_commit(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "other.txt").write_text("work")
                g("add", "other.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            hook = proj / ".git" / "hooks" / "post-merge"
            hook.write_text("#!/bin/sh\necho hooked > file.txt\n")
            hook.chmod(0o755)
            refused = subprocess.run([*gate, "prepare", "isolated", "--check", "grep -qx hooked file.txt"],
                                     capture_output=True, text=True)
            assert refused.returncode and "file.txt" in refused.stderr, refused.stderr
            assert not list(Path(board).glob("integration-*")) and not (Path(board) / "verification.json").exists()
            assert g("rev-parse", "HEAD") == base and (proj / "file.txt").read_text() == "v1"

    def test_a_replacement_candidate_keeps_a_previous_checkout_that_holds_files_of_its_own(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            first = json.loads(run(*gate, "prepare", "isolated", "--check", "true"))
            diagnostic = Path(first["path"]) / "diagnostic.log"
            diagnostic.write_text("only here")
            replaced = subprocess.run([*gate, "prepare", "isolated", "--check", "true"], capture_output=True, text=True)
            assert replaced.returncode == 0, replaced.stderr
            assert diagnostic.read_text() == "only here"
            assert first["path"] in replaced.stderr, replaced.stderr
            # An ignored file is as much the user's: `git worktree remove` would delete it unasked.
            second = json.loads(replaced.stdout)
            (proj / ".git" / "info" / "exclude").write_text("local.env\n")
            (Path(second["path"]) / "local.env").write_text("secret")
            third = json.loads(run(*gate, "prepare", "isolated", "--check", "true"))
            assert (Path(second["path"]) / "local.env").read_text() == "secret"
            run(*gate, "prepare", "isolated", "--check", "true")
            assert not Path(third["path"]).exists()  # a clean one is still removed

    def test_a_checkout_with_a_commit_of_its_own_outlives_a_replacement_and_a_prune(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)

            def committed(candidate):
                """A commit made on CANDIDATE's detached HEAD: the checkout is clean, and no ref holds the commit."""
                work = Path(candidate["path"])
                (work / "diagnostic.log").write_text("only here")
                g("add", "diagnostic.log", cwd=work)
                g("commit", "-q", "-m", "diagnostic", cwd=work)
                return work

            first = committed(json.loads(run(*gate, "prepare", "isolated", "--check", "true")))
            replaced = subprocess.run([*gate, "prepare", "isolated", "--check", "true"], capture_output=True, text=True)
            assert replaced.returncode == 0, replaced.stderr
            assert (first / "diagnostic.log").read_text() == "only here" and str(first) in replaced.stderr, replaced.stderr
            second = committed(json.loads(replaced.stdout))
            run(*post, "read", "coordinator")
            run(*post, "close")
            for dry in (["--dry-run"], []):
                out = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm", "prune", "--days=0", *dry)
                assert "kept %s: it holds commits" % second in out and "kept %s: it holds commits" % first in out, out
            assert (second / "diagnostic.log").read_text() == "only here"
            # One at the commit Swarm made for it, or back on a commit a branch holds, is still removed.
            g("reset", "-q", "--hard", "HEAD~1", cwd=second)
            g("checkout", "-q", "--detach", "main", cwd=first)
            out = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm", "prune", "--days=0")
            assert not second.exists() and not first.exists(), out

    def test_a_redispatch_keeps_a_passed_isolated_candidate_whose_tree_is_the_same(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            # Planned after the READY: the plan's first dispatch prepares it, and each later one builds the merge anew.
            run(*gate, "prepare", "isolated", "--check", "grep -qx v2 file.txt", "--when-ready")
            first = json.loads((Path(board) / "verification.json").read_text())
            run(*post, "post", "v", "@coordinator " + run(*gate, "test", first["candidate"], "v").splitlines()[-1])
            time.sleep(1.1)  # a merge made again a second later is another commit of the same tree
            said = run(*post, "dispatch")
            assert "already holds these files and reports" in said, said
            assert json.loads((Path(board) / "verification.json").read_text())["candidate"] == first["candidate"]
            assert [p.name for p in Path(board).glob("integration-*")] == ["integration-" + first["candidate"]]
            assert "ACCEPTED" in run(*gate, "accept", first["candidate"])

    def test_a_second_verifier_s_test_neither_reports_the_lock_nor_takes_the_first_one_s_pass(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Two verifiers")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "member", "v2", "role=verifier")
            run(*post, "ready", "w", text="done")
            cand = json.loads(run(*gate, "prepare", "shared", "--check", "sleep 2"))["candidate"]
            # Both are sent the same candidate: the second starts while the first one's checks run.
            first = subprocess.Popen([*gate, "test", cand, "v"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(0.8)
            second = subprocess.Popen([*gate, "test", cand, "v2"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            out, err = first.communicate(timeout=60)
            assert first.returncode == 0 and "VERIFIED " + cand in out, (out, err)
            waited, told = second.communicate(timeout=60)
            # It waited its turn, and by then the candidate had passed: it runs nothing, so the pass stays the first one's.
            assert second.returncode == 0 and "post no verdict" in told and "already passed" in waited, (waited, told)
            assert "VERIFIED " + cand not in waited
            run(*post, "post", "v", "@coordinator " + out.splitlines()[-1])  # posted only after the second one ended
            assert "ACCEPTED" in run(*gate, "accept", cand)
            # A prepare still hears at once that the checkout is busy: its dispatch is owed to a waiter instead.
            with (proj / ".git" / ".verification.lock").open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                refused = subprocess.run([*gate, "prepare", "shared", "--check", "true"], capture_output=True, text=True, timeout=10)
                assert refused.returncode == 1 and "already running" in refused.stderr, refused.stderr

    def test_an_isolated_candidate_whose_checkout_holds_a_mode_the_commit_does_not_is_refused(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()

            def change(g):
                (proj / "file.txt").write_text("v2")
                g("add", "file.txt")
            g, base, board, post, gate = self._isolated_candidate(proj, change)
            g("config", "core.filemode", "false")  # Git then sees no difference in the bit, and neither does its status
            hook = proj / ".git" / "hooks" / "post-merge"
            hook.write_text("#!/bin/sh\nchmod +x file.txt\n")
            hook.chmod(0o755)
            refused = subprocess.run([*gate, "prepare", "isolated", "--check", "test -x file.txt"], capture_output=True, text=True)
            assert refused.returncode == 1 and "executable bit" in refused.stderr and "file.txt" in refused.stderr, refused.stderr
            assert not list(Path(board).glob("integration-*"))
            hook.unlink()
            run(*gate, "prepare", "isolated", "--check", "test ! -x file.txt")

    def test_a_planned_candidate_is_prepared_when_the_swarm_folder_is_a_link(self):
        with tempfile.TemporaryDirectory() as t, tempfile.TemporaryDirectory() as elsewhere:
            proj = Path(t).resolve()
            self._init_git(proj)
            (proj / ".swarm").symlink_to(Path(elsewhere).resolve(), target_is_directory=True)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Linked"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            # verify.py resolves the run to where it is stored; the project is not above that folder.
            said = run(sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "shared", "--check", "true", "--when-ready")
            cand = json.loads((board / "verification.json").read_text())["candidate"]
            assert "candidate %s was prepared" % cand in said, said
            request = json.loads((board / "board.jsonl").read_text().splitlines()[-1])
            assert request["requests"] == cand and str(proj) in request["text"], request

    def test_a_planned_candidate_that_cannot_be_prepared_fails_the_command_and_asks_for_attention(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Plan"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(*post, "ready", "w", text="done")
            # A coding worker's candidate takes checks: the plan is recorded, and preparing from it fails.
            failed = subprocess.run([*gate, "prepare", "shared", "--no-checks", "--when-ready"], capture_output=True, text=True)
            assert failed.returncode == 1 and "could not be prepared" in failed.stdout, (failed.stdout, failed.stderr)

            def dispatch_items():
                return [item for item in json.loads(run(*post, "attention", "--json"))["items"] if item["kind"] == "dispatch"]
            assert len(dispatch_items()) == 1, run(*post, "attention", "--json")
            run(*post, "dispatch", ok=False)
            # A plan that prepares settles it, whoever's step runs it.
            assert "prepared" in run(*gate, "prepare", "shared", "--check", "true", "--when-ready")
            assert not dispatch_items() and "owed_dispatch" not in json.loads((board / "members.json").read_text())

    def test_a_replaced_verifier_s_successor_is_sent_the_candidate_s_test_command(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            board = Path(run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Plan"))
            post = [sys.executable, SCRIPTS / "board.py", board]
            run(*post, "member", "w")
            run(*post, "member", "v", "role=verifier")
            run(sys.executable, SCRIPTS / "verify.py", board, proj, "prepare", "shared", "--check", "true", "--when-ready")
            run(*post, "ready", "w", text="done")
            cand = json.loads((board / "verification.json").read_text())["candidate"]
            run(*post, "read", "v")  # the request is read, so the handover does not list it as unread
            run(*post, "replace", "v", "v2")
            assert json.loads((board / "verification.json").read_text())["candidate"] == cand  # nothing is prepared anew
            first = run(*post, "read", "v2")
            assert "test %s v2" % cand in first, first

    def test_attention_calls_a_pass_stale_when_acceptance_would_refuse_it_and_only_then(self):
        def stale(board):
            report = json.loads(run(sys.executable, SCRIPTS / "board.py", board, "attention", "--json"))
            return [item["text"] for item in report["items"] if item["kind"] == "stale"]
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            (proj / "file.txt").write_text("v2")
            gate, cand, board = self._verified(proj, "grep -qx v2 file.txt")
            # A follow-up worker's READY that changes no file leaves the pass as acceptance reads it.
            run(sys.executable, SCRIPTS / "board.py", board, "member", "follow")
            run(sys.executable, SCRIPTS / "board.py", board, "ready", "follow", text="nothing to change")
            assert not stale(board), stale(board)
            assert "ACCEPTED" in run(*gate, "accept", cand)
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            self._init_git(proj)
            (proj / "file.txt").write_text("v2")
            gate, cand, board = self._verified(proj, "grep -qx v2 file.txt")
            (proj / "file.txt").write_text("v3")  # edited after the pass, and no report says so
            assert stale(board) and "source files changed" in stale(board)[0], stale(board)
            run(*gate, "accept", cand, ok=False)

    def test_recover_index_clears_only_the_lock_its_own_dead_publication_left(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / "file.txt").write_text("verified contents\n")
            gate, cand, board = self._verified(proj, "grep -qx 'verified contents' file.txt")
            run(*gate, "accept", cand)
            original = (proj / ".git/index").read_bytes()
            # The publishing process dies between the ref update and the index replacement, finally blocks unrun.
            killed = subprocess.run([sys.executable, "-c", (
                "import os, sys; sys.path.insert(0, sys.argv[1]); import verify\n"
                "real = os.replace\n"
                "def replace(src, dest):\n"
                "    if os.path.basename(src) == 'index.lock': os._exit(9)\n"
                "    return real(src, dest)\n"
                "verify.os.replace = replace\n"
                "from pathlib import Path\n"
                "verify.commit(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], 'land')\n"),
                str(SCRIPTS), str(board), str(proj), cand], capture_output=True, text=True, env=NO_GIT_ENV)
            assert killed.returncode == 9, (killed.stdout, killed.stderr)
            lock = proj / ".git/index.lock"
            revision = g("rev-parse", "HEAD")
            assert lock.exists() and g("show", "HEAD:file.txt") == "verified contents"
            recovery, owner = board / f"commit-recovery-{cand}.json", board / "index-lock.json"
            assert recovery.exists()
            record = json.loads(owner.read_text())
            # A live owner may still be publishing: its lock stays.
            owner.write_text(json.dumps({**record, "pid": os.getpid()}))
            refused = subprocess.run([*gate, "recover-index", cand], capture_output=True, text=True)
            assert refused.returncode and "locked" in refused.stderr and lock.exists(), refused.stderr
            owner.write_text(json.dumps(record))
            # A lock some other process made in its place is never Swarm's to remove.
            ours = lock.read_bytes()
            lock.unlink()
            lock.write_bytes(b"someone else's index")
            refused = subprocess.run([*gate, "recover-index", cand], capture_output=True, text=True)
            assert refused.returncode and "locked" in refused.stderr and lock.read_bytes() == b"someone else's index"
            lock.unlink()
            assert (proj / ".git/index").read_bytes() == original
            lock.write_bytes(ours)
            refused = subprocess.run([*gate, "recover-index", cand], capture_output=True, text=True)
            assert refused.returncode and lock.exists(), refused.stderr  # same bytes, another file
            lock.unlink()
            # The dead publication's own lock is cleared, and recovery goes on.
            subprocess.run([sys.executable, "-c", (
                "import os, sys; sys.path.insert(0, sys.argv[1]); import verify\n"
                "real = os.replace\n"
                "def replace(src, dest):\n"
                "    if os.path.basename(src) == 'index.lock': os._exit(9)\n"
                "    return real(src, dest)\n"
                "verify.os.replace = replace\n"
                "from pathlib import Path\n"
                "verify.recover_index(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])\n"),
                str(SCRIPTS), str(board), str(proj), cand], capture_output=True, text=True, env=NO_GIT_ENV)
            assert lock.exists()  # a recovery that dies leaves its own lock, which the next one clears too
            assert f"RECOVERED INDEX {revision}" in run(*gate, "recover-index", cand)
            assert not lock.exists() and not recovery.exists() and not owner.exists()
            assert g("diff", "--cached", "--name-only") == ""

    def test_a_partial_candidate_reads_the_declarations_of_the_upstream_work_it_holds(self):
        with tempfile.TemporaryDirectory() as t:
            proj = Path(t).resolve()
            g = self._init_git(proj)
            (proj / "notes.txt").write_text("line\n")
            g("add", "notes.txt")
            g("commit", "-m", "notes")
            board = run(sys.executable, SCRIPTS / "board.py", proj / ".swarm" / "reg", "init", "Partial")
            post = [sys.executable, SCRIPTS / "board.py", board]
            gate = [sys.executable, SCRIPTS / "verify.py", board, proj]
            run(*post, "member", "a")
            run(*post, "member", "b", "depends=a")
            run(*post, "member", "v", "role=verifier")
            g("switch", "-q", "-c", "a")
            (proj / "notes.txt").write_text("changed")
            g("commit", "-q", "-am", "a")
            upstream = g("rev-parse", "HEAD")
            g("switch", "-q", "-c", "b")
            (proj / "other.txt").write_text("b\n")
            g("add", "other.txt")
            g("commit", "-q", "-m", "b")
            downstream = g("rev-parse", "HEAD")
            g("switch", "-q", "main")
            run(*post, "ready", "a", upstream, text="done\nNEWLINE: notes.txt")
            run(*post, "ready", "b", downstream, text="done")
            assert json.loads(run(*gate, "prepare", "isolated", "--check", "true", "--members", "a,b"))["partial"]
            assert json.loads(run(*gate, "prepare", "isolated", "--check", "true", "--members", "b"))["partial"]


if __name__ == "__main__":
    unittest.main()

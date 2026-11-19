#!/usr/bin/env python3
"""Exercise the verification gate against temporary Git repositories."""
import sys

sys.dont_write_bytecode = True  # a test run leaves no __pycache__ in the plugin folder
from pathlib import Path
import fcntl
import json
import os
import shlex
import subprocess
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
            for bad_timeout in ("0", "-5", "nan", "inf", "abc"):
                env = dict(os.environ, SWARM_VERIFY_TIMEOUT=bad_timeout)
                res = subprocess.run([*gate, "test", cand["candidate"], "v"], capture_output=True, text=True, env=env)
                assert res.returncode != 0 and "SWARM_VERIFY_TIMEOUT must be a positive number" in res.stderr
            line = run(*gate, "test", cand["candidate"], "v").splitlines()[-1]
            run(*post, "post", "v", "@coordinator " + line)
            run(*gate, "accept", cand["candidate"])
            members_path = Path(board) / "members.json"
            state = json.loads(members_path.read_text())
            assert "accepted_seq" in state
            del state["accepted_seq"]
            members_path.write_text(json.dumps(state))
            run(*gate, "accept", cand["candidate"])
            assert "accepted_seq" in json.loads(members_path.read_text())


if __name__ == "__main__":
    scenario()
    print("ok")

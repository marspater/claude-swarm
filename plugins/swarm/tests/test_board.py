#!/usr/bin/env python3
"""Check for board.py: python3 test_board.py"""
import sys

sys.dont_write_bytecode = True  # a test run leaves no __pycache__ in the plugin folder
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

BOARD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "skills", "swarm", "scripts", "board.py")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402


def saved(d):
    with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
        return json.load(f)


def run(d, *args, stdin=None, ok=True):
    code, out, err = engine.board(d, *args, stdin=stdin)
    assert (code == 0) == ok, (args, out, err)
    return out


def woken(d):
    return [line.split()[0] for line in run(d, "wake").splitlines()]


def scenario():
    with tempfile.TemporaryDirectory() as tmp:
        name = os.path.join(tmp, ".swarm", "demo")
        # every init is its own run, even under one name in one second
        d = run(name, "init", "Demo", "swarm").strip()
        other = run(name, "init", "Second").strip()
        assert d != other and os.path.dirname(d) == os.path.dirname(other)
        run(other, "post", "coordinator", "hello")
        assert run(d, "read", "coordinator") == "no new posts\n"  # the first run saw nothing of it
        run(name, "read", "coordinator", ok=False)  # the bare name is no run
        run(os.path.join(tmp, "elsewhere"), "init", "x", ok=False)  # must not drop a .gitignore outside .swarm
        assert not os.path.exists(os.path.join(tmp, ".gitignore"))
        for member, group in [("parser", "-"), ("fix-1", "fix"), ("fix-2", "fix"), ("verifier", "-")]:
            run(d, "member", member, "group=" + group, "id=agent-" + member)

        # 20 posts at once: seq 1..20, each exactly once, every line whole JSON
        with ThreadPoolExecutor(20) as pool:
            list(pool.map(lambda i: run(d, "post", "parser", stdin="note %d\n`$HOME` $(x) 'q'\n" % i), range(20)))
        with open(os.path.join(d, "board.jsonl")) as f:
            assert sorted(json.loads(line)["seq"] for line in f) == list(range(1, 21))

        # routing: name, group and @all expand; the sender, unknown names and emails are not woken
        run(d, "read", "verifier")
        assert "-> @verifier\n" in run(d, "post", "parser", stdin="@Verifier, please check. cc a@b.com and @Override")
        assert run(d, "wake").split()[:2] == ["@verifier", "agent-verifier"]
        assert woken(d) == ["@verifier"]  # inspecting a wake leaves it pending
        first_claim = run(d, "claim", "verifier", "agent-verifier", "21").strip()
        assert first_claim
        assert not run(d, "claim", "verifier", "agent-verifier", "21").strip()
        run(d, "post", "parser", "@verifier one more thing")
        run(d, "woke", "verifier", "21", first_claim)
        assert woken(d) == ["@verifier"]  # acknowledging #21 cannot consume #22
        assert not run(d, "claim", "verifier", "wrong-address", "22").strip()
        claim = run(d, "claim", "verifier", "agent-verifier", "22").strip()
        assert claim
        run(d, "woke", "verifier", "22", first_claim, ok=False)
        assert not run(d, "claim", "verifier", "agent-verifier", "22").strip()
        assert "* #21" in run(d, "read", "verifier")
        run(d, "post", "fix-1", "@fix status?")
        claim = run(d, "claim", "fix-2", "agent-fix-2", "23").strip()
        run(d, "woke", "fix-2", "23", claim)
        assert woken(d) == []
        run(d, "member", "fix-2", "killed=1")
        run(d, "post", "verifier", "@all done")
        assert woken(d) == ["@parser", "@fix-1"]
        run(d, "member", "late")
        run(d, "post", "coordinator", "@late BRIEF")
        assert woken(d) == ["@parser", "@fix-1", "@late"]  # not spawned yet: listed until it has an id

        # history: a removed member keeps its edges, and `show` gives a replacement the old posts
        status = run(d, "status")
        assert "@fix-1 -> @fix-2 x1" in status and "@verifier -> @fix-2" not in status
        assert "#23" in run(d, "show", "fix-2") and "#24" not in run(d, "show", "fix-2")
        assert "#25" in run(d, "read", "late") and "#25" in run(d, "show", "late")
        run(d, "post", "nobody", "hi", ok=False)
        run(d, "post", "parser", "@coordinator @verifier READY parser. all done", ok=False)  # must use the ready command
        run(d, "post", "parser", "@coordinator not READY yet, one test left")
        binding = "a" * 64
        run(d, "bind", binding)
        run(d, "bind", "b" * 64, ok=False)
        assert run(os.path.dirname(d), "restore", binding).strip() == d
        assert not run(os.path.dirname(d), "restore", "b" * 64).strip()
        run(d, "member", "late", "depends=parser")
        run(d, "member", "parser", "depends=late", ok=False)
        run(d, "member", "parser", "depends=missing", ok=False)
        run(d, "ready", "late", stdin="blocked", ok=False)
        run(d, "ready", "parser", stdin="@late ready to use")
        run(d, "ready", "late", stdin="done")
        run(d, "revise", "parser", "changing the contract")
        run(d, "ready", "late", stdin="blocked again", ok=False)
        run(d, "pause", "waiting for a decision")
        assert not run(d, "wake").strip()
        run(d, "resume")
        assert woken(d)
        # a reader gets posts addressed to it in full and the rest as one line each
        run(d, "post", "parser", stdin="@fix-1 first line for fix-1\nsecond line")
        seen = run(d, "read", "late")
        assert "first line for fix-1" in seen and "second line" not in seen
        assert "second line" in run(d, "read", "fix-1")
        run(d, "post", "parser", stdin="note to nobody\nmore")
        assert "more" in run(d, "read", "late", "--all")

        # attention: an unanswered question is listed with its post until the recipient answers the asker
        run(d, "post", "late", "@parser which format do you emit?")
        report = json.loads(run(d, "attention", "--json"))
        assert [i["member"] for i in report["items"] if i["kind"] == "unread"] == ["coordinator"]
        question = [i for i in report["items"] if i["kind"] == "question"]
        assert question and question[0]["member"] == "parser" and report["members"]["late"]["asked"] == question[0]["seq"]
        assert report["members"]["late"]["type"] == "worker" and report["members"]["late"]["model"] == "sonnet"
        run(d, "post", "parser", "@late JSON lines")  # cites nothing, so it settles nothing
        assert [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        run(d, "post", "parser", "@late re #%d: JSON lines" % question[0]["seq"])
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

        # limits: the roster cannot exceed them, and a model can be reserved for one type
        run(d, "limit", "fable=architect", "max_workers=6")
        run(d, "member", "probe", "profile=investigator", "writes=0", "model=fable", ok=False)  # Fable is an escalation only
        run(d, "member", "probe", "profile=investigator", "writes=0", "model=opus", "effort=high", "owns=the retry bug")
        run(d, "member", "design", "profile=architect", "writes=0")
        run(d, "member", "extra", ok=False)  # a seventh worker
        plan = run(d, "plan")
        assert "@probe" in plan and "investigator" in plan and "the retry bug" in plan and "limits:" in plan
        run(d, "limit", "bogus=1", ok=False)
        run(d, "limit", "max_workers=2")  # a limit set below the roster is reported, and ids can still be recorded
        run(d, "member", "probe", "id=agent-probe")
        run(d, "member", "one-more", ok=False)
        run(d, "limit", "max_workers=9")
        # a designer is a profile that writes: no writes=0 is forced on it, and it runs on its own defaults
        run(d, "member", "art", "profile=designer", "owns=assets/icons")
        art = json.loads(run(d, "attention", "--json"))["members"]["art"]
        assert (art["type"], art["model"], art["effort"]) == ("designer", "opus", "high")
        assert saved(d)["members"]["art"].get("writes") != "0"
        run(d, "member", "art", "role=verifier", ok=False)  # the profile belongs to a worker
        run(d, "member", "art", "consult=1", ok=False)
        # unlike a specialist, its report may carry a commit: this one is refused only because the project has no such commit
        assert "no commit in the project's repository" in subprocess.run(
            [sys.executable, BOARD, d, "ready", "art", "a" * 40], input="icons drawn", capture_output=True, text=True).stderr
        run(d, "ready", "art", stdin="icons drawn")
        # a specialist turned designer writes again; one registered writes=0 stays read-only
        run(d, "member", "art", "profile=architect")
        run(d, "member", "art", "profile=designer")
        with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
            assert json.load(f)["members"]["art"].get("writes") != "0"
        run(d, "member", "art", "writes=0")
        run(d, "member", "art", "profile=designer")  # naming the profile again does not undo an explicit writes=0
        with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
            assert json.load(f)["members"]["art"].get("writes") == "0"
        # tail: whole posts only, the newest within the byte budget; the pane reads it when the board outgrows one read
        with open(os.path.join(d, "board.jsonl"), "rb") as f:
            whole = f.read()
        assert run(d, "tail").encode() == whole
        cut = run(d, "tail", "600").encode()
        assert 0 < len(cut) <= 600 and whole.endswith(cut) and whole[len(whole) - len(cut) - 1:len(whole) - len(cut)] == b"\n"
        json.loads(cut.split(b"\n")[0])
        run(d, "tail", "many", ok=False)
        # a verification file that is not a candidate is refused, not a traceback
        run(d, "member", "judge", "role=verifier")
        for junk in ("null", "[]", '"text"'):
            with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
                f.write(junk)
            refused = subprocess.run([sys.executable, BOARD, d, "post", "judge", "@coordinator VERIFIED abc def"], capture_output=True, text=True)
            assert refused.returncode != 0 and "Traceback" not in refused.stderr, refused.stderr
        os.unlink(os.path.join(d, "verification.json"))
        run(d, "member", "judge", "killed=1")
        run(d, "member", "art", "killed=1")

        # replace: the new member inherits the brief, the dependants and a pointer to the old one's posts
        run(d, "post", "coordinator", stdin="@design BRIEF\nOwns: the storage design\nDone when: a plan is posted")
        run(d, "member", "late", "depends=parser,design")
        run(d, "post", "late", "@design which store should I target?")
        out = run(d, "replace", "design", "design-2")
        assert "now yours to answer" in run(d, "show", "design-2")
        assert "swarm:architect" in out
        brief = run(d, "show", "design-2")
        assert "@design-2 BRIEF (replaces design)" in brief and "Owns: the storage design" in brief
        status = run(d, "status")
        assert "depends=parser,design-2" in status
        blocked = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "blocked"]
        assert not blocked  # the dependant follows the replacement, so nothing waits on a removed member

        # stale verification: a change reported after VERIFIED is flagged with the VERIFIED post
        run(d, "member", "verifier", "role=verifier")
        run(d, "post", "verifier", "@parser NOT VERIFIED: one test fails")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "stale"]
        run(d, "post", "verifier", "@coordinator VERIFIED, I ran the suite myself", ok=False)  # no candidate behind it
        # ... and a line that merely looks right is not one: it must be the current candidate's, passed by the sender
        line = "VERIFIED %s %s" % ("a" * 16, "b" * 64)
        run(d, "post", "verifier", "@coordinator " + line, ok=False)
        candidate = {"candidate": "a" * 16, "commit": None, "digest": "b" * 64}
        def verification(**extra):
            with open(os.path.join(d, "verification.json"), "w") as f:
                json.dump({**candidate, **extra}, f)
        verification()  # prepared, not passed
        run(d, "post", "verifier", "@coordinator " + line, ok=False)
        verification(verified_by="parser")  # passed by someone else
        run(d, "post", "verifier", "@coordinator " + line, ok=False)
        # a record with no sources to compare cannot be shown current, accepted or not;
        # test_verify.py posts the lines of real candidates and covers the stale item
        for extra in ({}, {"accepted": True}, {"accepted": True, "commit": "c" * 40}):
            verification(verified_by="verifier", **extra)
            run(d, "post", "verifier", "@coordinator " + line, ok=False)
            run(d, "post", "verifier", "@coordinator VERIFIED %s %s" % ("a" * 16, "c" * 40), ok=False)
        os.remove(os.path.join(d, "verification.json"))
        run(d, "ready", "parser", stdin="changed again")

        # --headers: a long report costs the reader one line, and is still marked read
        run(d, "post", "parser", stdin="@coordinator summary line\n" + "detail\n" * 50)
        assert "[unread] #" in run(d, "attention")  # reports the coordinator has not read are listed
        brief = run(d, "read", "coordinator", "--headers")
        assert "[unread]" not in run(d, "attention")
        assert "summary line" in brief and "detail" not in brief
        assert "READY | done" in brief  # a READY post shows its report's first line too
        assert run(d, "read", "coordinator") == "no new posts\n"
        run(d, "close")
        assert not run(d, "wake").strip()
        assert "(closed)" in run(d, "status")
        # Each command starts a fresh process. Duplicate and concurrent reports
        # must update the same run without losing turns or counting one twice.
        budget_run = run(name, "init", "Persistent budget").strip()
        run(budget_run, "limit", "budget=100")
        run(budget_run, "member", "worker", "id=worker-address")
        run(budget_run, "post", "coordinator", "@worker work")
        actor = "a" * 64
        reports = [("1" * 64, actor, "60"), ("1" * 64, actor, "60"),
                   ("2" * 64, "coordinator", "40")]
        with ThreadPoolExecutor(3) as pool:
            accounting = list(pool.map(lambda args: json.loads(run(budget_run, "account", *args)), reports))
        assert sum(entry["paused"] for entry in accounting) == 1
        assert "100 of 100 tokens" in run(budget_run, "status")
        assert not run(budget_run, "wake").strip()
        assert not run(budget_run, "claim", "worker", "worker-address", "1").strip()
        run(budget_run, "resume", ok=False)
        run(budget_run, "limit", "budget=120")
        run(budget_run, "resume")
        assert "@worker" in run(budget_run, "wake")
        duplicate = json.loads(run(budget_run, "account", "2" * 64, "coordinator", "42"))
        assert not duplicate["paused"] and duplicate["accepted"] == 40 and duplicate["total"] == 100, duplicate
        run(budget_run, "pause", "awaiting a decision")
        assert not json.loads(run(budget_run, "account", "3" * 64, actor, "21"))["paused"]
        assert "awaiting a decision" in run(budget_run, "attention")
        run(budget_run, "resume", ok=False)
        run(budget_run, "account", "bad key", actor, "1", ok=False)
        # The unweighted detail is kept by actor and wake, once per report, and never changes what is charged.
        run(budget_run, "limit", "budget=1000")
        run(budget_run, "resume")
        owner = hashlib.sha256(b"swarm-agent:worker-address").hexdigest()
        for report in ("5", "5", "6"):
            run(budget_run, "account", report * 64, owner, "30", "wake:1,2,300,4")
        run(budget_run, "account", "7" * 64, "coordinator", "9", "relay+unread:5,0,40,1")
        with open(os.path.join(budget_run, "members.json"), encoding="utf-8") as f:
            usage = json.load(f)["usage"]
        assert usage["detail"] == {owner: {"wake": [2, 2, 4, 600, 8]}, "coordinator": {"relay+unread": [1, 5, 0, 40, 1]}}, usage
        assert usage["tokens"][owner] == 60, usage
        with open(run(budget_run, "export").strip(), encoding="utf-8") as f:
            exported = f.read()
        assert "| @worker | worker | wake | 2 | 2 | 4 | 600 | 8 |" in exported, exported
        assert "| @coordinator | coordinator | relay+unread | 1 | 5 | 0 | 40 | 1 |" in exported, exported
        for bad in ("wake:1,2,3", "Wake:1,2,3,4", "wake:1,2,3,-4", "wake:1,2,3,4,5,6", ":1,2,3,4"):
            run(budget_run, "account", "8" * 64, actor, "1", bad, ok=False)
        run(budget_run, "account", "4" * 64, "raw-address", "1", ok=False)

        finding_run = run(name, "init", "Investigator finding review").strip()
        run(finding_run, "member", "explorer", "profile=explorer", "writes=0", "id=explorer")
        run(finding_run, "member", "investigator", "profile=investigator", "writes=0", "id=investigator", "depends=explorer")
        run(finding_run, "member", "writer", "id=writer", "depends=investigator")
        run(finding_run, "ready", "explorer", stdin="Trace starts in refresh.")
        run(finding_run, "read", "investigator")

        assert "-> @coordinator\n" in run(finding_run, "ready", "investigator", stdin="A runtime log is still needed.")
        assert "@writer" not in woken(finding_run)
        run(finding_run, "ready", "writer", stdin="Still blocked.", ok=False)
        review = json.loads(run(finding_run, "attention", "--json"))
        assert not review["members"]["investigator"]["ready"]
        assert review["members"]["writer"]["blocked_on"] == ["investigator"]
        assert [(item["member"], item["seq"]) for item in review["items"] if item["kind"] == "review"] == [("investigator", 2)]

        run(finding_run, "revise", "investigator", "Awaiting runtime evidence.")
        assert "@writer" not in woken(finding_run)
        run(finding_run, "confirm", "investigator", "2", ok=False)
        run(finding_run, "ready", "investigator", stdin="The log confirms the retry runs twice.")
        run(finding_run, "revise", "explorer", "Entry point changed.")
        run(finding_run, "ready", "explorer", stdin="Mapped the corrected route.")
        run(finding_run, "confirm", "investigator", "4", ok=False)
        run(finding_run, "ready", "investigator", stdin="The corrected route also retries twice.")
        run(finding_run, "confirm", "investigator", "4", ok=False)
        assert "-> @writer\n" in run(finding_run, "confirm", "investigator", "7")
        run(finding_run, "confirm", "investigator", "7", ok=False)
        assert "@writer" in woken(finding_run)
        confirmed = run(finding_run, "read", "writer")
        assert "finding #7" in confirmed and "show --post=7" in confirmed  # the one post, not the member's history
        run(finding_run, "ready", "writer", stdin="Verified the fix.")
        review = json.loads(run(finding_run, "attention", "--json"))
        assert review["members"]["investigator"]["ready"] and review["members"]["writer"]["ready"]
        assert not [item for item in review["items"] if item["kind"] == "review"]
        run(finding_run, "revise", "investigator", "A new trace changes the finding.")
        assert "@writer" in woken(finding_run)
        run(finding_run, "ready", "writer", stdin="Blocked after revision.", ok=False)
        # an investigator starts on Opus; Fable arrives only by replacing one that failed
        escalation = run(name, "init", "Escalation").strip()
        run(escalation, "member", "trace", "profile=investigator", "writes=0")
        assert "opus" in run(escalation, "plan") and "fable" not in run(escalation, "plan")
        run(escalation, "member", "trace", "model=claude-fable-5-2", ok=False)
        run(escalation, "replace", "trace", "trace-2", "model=fable", "effort=medium")
        assert "fable" in run(escalation, "plan")

        # adopt: a conversation that never typed a recognisable board command still gets its run,
        # the newest open one that registers the member it is starting, and nobody else's
        parent, key = os.path.dirname(escalation), "c" * 64
        assert not run(parent, "adopt", key, "nobody-here", ok=False).strip()  # open runs exist, none has the name
        assert run(parent, "adopt", key, "trace-2").strip() == escalation
        assert run(parent, "restore", key).strip() == escalation
        assert not run(parent, "adopt", "d" * 64, "trace-2", ok=False).strip()  # another conversation's run
        assert run(parent, "adopt", key, "trace-2").strip() == escalation
        run(escalation, "close")
        assert not run(parent, "adopt", key, "trace-2", ok=False).strip()

        # Nothing addressed to a member goes unseen: its own posts say what it owes a read, a wake it
        # answered without reading is repeated, and the run does not close over unread reports.
        kept = run(name, "init", "Attention").strip()
        run(kept, "member", "w", "id=agent-w")
        assert "UNREAD" not in run(kept, "post", "coordinator", "@w go")
        run(kept, "post", "w", "@coordinator which file?")
        assert "UNREAD: 1 post(s) address @coordinator from #2 on" in run(kept, "post", "coordinator", "note")
        assert "has not read 1 post(s)" in subprocess.run(
            [sys.executable, BOARD, kept, "close"], capture_output=True, text=True).stderr
        for attempt in range(3):
            assert woken(kept) == ["@w"]
            run(kept, "woke", "w", "1", run(kept, "claim", "w", "agent-w", "1").strip())
            assert woken(kept) == [] and ("[ignored]" in run(kept, "attention")) == (attempt == 2)
            run(kept, "rearm", "60000", "agent-w")  # a turn that was already running when the wake landed
            assert woken(kept) == []
            run(kept, "rearm", "0", "agent-w", "other-id")  # the turn the wake started ended and #1 is still unread
        assert woken(kept) == []  # three wakes for one post: now the coordinator's problem
        run(kept, "retry", "w")
        assert woken(kept) == ["@w"] and "[ignored]" not in run(kept, "attention")
        run(kept, "read", "w")
        run(kept, "rearm", "0", "agent-w")
        assert woken(kept) == []
        run(kept, "post", "coordinator", "@w again")
        run(kept, "woke", "w", "4", run(kept, "claim", "w", "agent-w", "4").strip())
        run(kept, "member", "w", "id=agent-w2")  # a restarted member starts with a clean wake record
        assert woken(kept) == ["@w"] and "told" not in saved(kept)["members"]["w"]
        run(kept, "read", "w")
        run(kept, "read", "coordinator")
        run(kept, "close")

        # A run is adopted only when there is no doubt which one: never the wrong conversation's.
        twin = os.path.join(tmp, "twins", ".swarm")
        first, second = (run(os.path.join(twin, "job"), "init", t).strip() for t in ("One", "Two"))
        with open(os.path.join(twin, ".gitignore")) as f:
            assert f.read() == "*\n"
        with open(os.path.join(twin, ".gitignore"), "w") as f:
            f.write("important-rule\n")
        for each in (first, second):
            run(each, "member", "worker")
        guess = subprocess.run([sys.executable, BOARD, twin, "adopt", "e" * 64, "worker"], capture_output=True, text=True)
        assert guess.returncode == 3 and not guess.stdout and os.path.basename(first) in guess.stderr, guess
        # the run folder named in the member's prompt settles it
        assert run(twin, "adopt", "e" * 64, "worker", "Board: python3 board.py %s read worker" % first).strip() == first
        assert run(twin, "adopt", "e" * 64, "worker").strip() == first  # now this conversation's own
        assert run(twin, "adopt", "f" * 64, "worker").strip() == second  # the only unowned one left
        # an open run the conversation could drive that lacks the name: the member is unregistered, not "no swarm here"
        stranger = subprocess.run([sys.executable, BOARD, twin, "adopt", "f" * 64, "ghost"], capture_output=True, text=True)
        assert stranger.returncode == 4 and not stranger.stdout, stranger
        third = run(os.path.join(twin, "job"), "init", "Three").strip()
        with open(os.path.join(twin, ".gitignore")) as f:
            assert f.read() == "important-rule\n"  # a later run leaves the project's own file alone

        # An unanswered question stays listed until its recipient answers it.
        run(third, "member", "w", "id=agent-w")
        asked = lambda: [i["seq"] for i in json.loads(run(third, "attention", "--json"))["items"] if i["kind"] == "question"]
        run(third, "post", "w", "@coordinator which file should I change?")
        run(third, "post", "w", "@coordinator and which branch?")
        assert asked() == [1, 2]
        run(third, "post", "coordinator", "@w BRIEF\nOwns: a.py")  # a protocol post answers nothing
        assert asked() == [1, 2]
        run(third, "post", "coordinator", "@w re #2: main")  # a reply that cites a question answers that one only
        assert asked() == [1]
        run(third, "post", "w", "@coordinator and may I touch b.py?")
        assert asked() == [1, 5]
        # a plain reply cites nothing, so it answers nothing; one reply can cite several
        run(third, "post", "coordinator", "@w change a.py as in #2, yes to b.py, and post READY when done")
        assert asked() == [1, 5]
        run(third, "post", "coordinator", "@w re #1 and #5: a.py, and yes")
        assert asked() == []

        # Replacement keeps what registration checked: a consultant stays one, and nobody ends up waiting for itself.
        swap = run(os.path.join(tmp, "swap", ".swarm", "job"), "init", "Swap").strip()
        roster = lambda: saved(swap)["members"]
        run(swap, "member", "advisor", "profile=architect", "writes=0", "consult=1")
        run(swap, "replace", "advisor", "advisor-2")
        assert roster()["advisor-2"].get("consult") == "1"
        run(swap, "member", "base")
        run(swap, "member", "next", "depends=base")
        loop = subprocess.run([sys.executable, BOARD, swap, "replace", "base", "base-2", "depends=next"], capture_output=True, text=True)
        assert loop.returncode and "cycle" in loop.stderr, loop
        assert "base-2" not in roster() and not roster()["base"].get("killed") and roster()["next"]["depends"] == "base"
        run(swap, "replace", "base", "base-2", "depends=ghost", ok=False)
        run(swap, "replace", "base", "base-2")
        assert roster()["next"]["depends"] == "base-2"
        run(swap, "member", "base-2", "killed=1")  # removed with no successor: @next is blocked, and can still be replaced
        run(swap, "replace", "next", "next-2")
        assert roster()["next-2"]["depends"] == "base-2"

        # A name is one a mention can carry: "@name-" in prose is @name, so no name ends that way.
        for bad in ("tail_", "tail-"):
            run(swap, "member", bad, ok=False)
            run(swap, "replace", "next", bad, ok=False)
        assert "-> @next-2" in run(swap, "post", "coordinator", "ask @next-2- or @next-2_, then @base.")
        state = saved(swap)  # a roster from before the rule still routes
        state["members"]["tail_"] = {"role": "worker", "last_read_seq": 0}
        with open(os.path.join(swap, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        assert "@tail_" in run(swap, "post", "coordinator", "@tail_ go")
        run(swap, "member", "tail_", "id=agent-tail")  # and stays manageable
        run(swap, "member", "tail_", "killed=1")

        durable = run(name, "init", "Interrupted update").strip()
        roster_path = os.path.join(durable, "members.json")
        board_path = os.path.join(durable, "board.jsonl")
        for command in (("member",), ("read", "--all"), ("member", "w", "id"),
                        ("member", "w", "last_read_seq=20"), ("member", "w", "writes=0", "writes=1"),
                        ("member", "coordinator", "killed=1"), ("limit", "budget=²")):
            result = subprocess.run([sys.executable, BOARD, durable, *command], capture_output=True, text=True)
            assert result.returncode and "Traceback" not in result.stderr, result
        run(durable, "member", "w", "id=current")
        run(durable, "member", "observer", "profile=verifier")
        assert "role=verifier" in next(line for line in run(durable, "status").splitlines() if "@observer" in line)
        run(durable, "member", "other", "id=current", ok=False)
        run(durable, "started", "w", "unwanted", "old-address", ok=False)
        run(durable, "started", "w", "replacement", "current")
        run(durable, "started", "w", "replacement", "current")
        run(durable, "post", "w", "@coordinator which branch?")
        run(durable, "post", "coordinator", "@w re #999: unrelated")
        assert "[question] #1" in run(durable, "attention")
        run(durable, "post", "coordinator", "@w re #1: main")
        assert "[question]" not in run(durable, "attention")
        # Simulate interruption after the roster write and partway through the replacement brief.
        with open(roster_path) as f:
            state = json.load(f)
        state["members"]["other"] = {"role": "worker", "last_read_seq": 3}
        pending = {"seq": 4, "agent": "coordinator", "text": "@other BRIEF\n" + "é" * 70,
                   "time": "2026-11-18T10:00:00+0000", "to": ["other"]}
        state["pending_post"] = pending
        with open(roster_path, "w") as f:
            json.dump(state, f)
        with open(board_path, "ab") as f:
            f.write(b'{"seq": 4, "agent":"coor')
        assert "#4" in run(durable, "show", "--post=4")
        # Replay after the post was appended but before the pending roster field was cleared.
        with open(roster_path, "w") as f:
            json.dump(state, f)
        assert run(durable, "show", "other").count("#4") == 1
        run(durable, "post", "coordinator", "@other " + "x" * 160)
        first = run(durable, "read", "other", "--max-bytes=256")
        assert "#4" in first and "#5" not in first and "more post(s) remain" in first
        assert "#5" in run(durable, "read", "other", "--max-bytes=256")
        run(durable, "read", "coordinator")
        run(durable, "member", "w", "killed=1")
        run(durable, "post", "w", "retired", ok=False)
        run(durable, "close")
        run(durable, "post", "other", "late", ok=False)
        run(durable, "replace", "other", "next", ok=False)

        detached = run(name, "init", "Restore pointer").strip()
        key = "1" * 64
        run(detached, "member", "new-probe", "id=recorded-probe")
        parent = os.path.dirname(detached)
        assert run(parent, "locate", key, "new-probe").strip() == detached
        assert not run(parent, "restore", key).strip()
        run(detached, "bind", key)
        os.unlink(os.path.join(parent, ".bindings", key))
        assert run(parent, "restore", key).strip() == detached
        assert run(parent, "agent-run", key, "recorded-probe").strip() == detached

        # edge cases of the protocol and the roster
        edge = run(name, "init", "Edges").strip()
        for member in ("a", "b", "gone"):
            run(edge, "member", member, "id=agent-" + member)
        run(edge, "member", "v", "role=verifier", "id=agent-v")
        # several numbers after one "re" answer several questions; a removed asker's question closes with it
        run(edge, "post", "a", "@b which port?")
        run(edge, "post", "a", "@b and which host?")
        run(edge, "post", "gone", "@b anything to add?")
        assert len([i for i in json.loads(run(edge, "attention", "--json"))["items"] if i["kind"] == "question"]) == 3
        run(edge, "post", "b", "@a re #1, #2 and nothing else: 8080 on localhost")
        run(edge, "member", "gone", "killed=1")
        assert not [i for i in json.loads(run(edge, "attention", "--json"))["items"] if i["kind"] == "question"]
        # the protocol word is on the first line: a word on line two is prose, and FINDING is a report, not a question
        run(edge, "post", "v", "@coordinator\nVERIFIED is what I would say if I had a candidate")
        run(edge, "post", "a", "@coordinator FINDING is it the cache?")
        assert not [i for i in json.loads(run(edge, "attention", "--json"))["items"] if i["kind"] == "question"]
        # the coordinator is the conversation: only its backend is set on the roster
        run(edge, "member", "coordinator", "model=opus", ok=False)
        run(edge, "member", "coordinator", "backend=native")
        run(edge, "member", "a", "group=all", ok=False)
        run(edge, "member", "a", "group=Fix", ok=False)
        run(edge, "member", "a", "group=b", ok=False)  # a member's name
        # a limit names agent types or members; a typo is refused or noted
        run(edge, "limit", "opus=Architects!", ok=False)
        assert "names no agent type" in run(edge, "limit", "opus=architects")
        assert "note:" not in run(edge, "limit", "opus=architect,a,none")
        # show, post and revise with odd arguments
        run(edge, "show", "--unknown", ok=False)
        run(edge, "show", "nobody", ok=False)
        run(edge, "post", "a", "   ", stdin="from stdin")
        assert "from stdin" in run(edge, "show", "--post=7")
        run(edge, "ready", "a", stdin="done")
        run(edge, "revise", "a")
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            assert json.loads(f.readlines()[-1])["text"] == "REVISE"
        # a removed member can still be replaced: its dependants then wait for the successor
        run(edge, "member", "base")
        run(edge, "member", "b", "depends=base")
        run(edge, "member", "base", "killed=1")
        run(edge, "replace", "base", "base-2")
        assert saved(edge)["members"]["b"]["depends"] == "base-2"
        # A confirmed finding waits for the remaining workers before waking the verifier.
        run(edge, "member", "probe", "profile=investigator", "writes=0", "model=sonnet")
        run(edge, "ready", "probe", stdin="cause found")
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            finding = len(f.readlines())
        run(edge, "confirm", "probe", str(finding))
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            assert "v" not in json.loads(f.readlines()[-1])["to"]
        # a board whose sequence is a JSON true is refused, not read as post 1
        forged = run(name, "init", "Forged").strip()
        with open(os.path.join(forged, "board.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"seq": True, "agent": "coordinator", "text": "x", "time": "t"}) + "\n")
        run(forged, "status", ok=False)
        # a closed run asks for nothing, cannot be bound by another conversation, and is not restored
        run(edge, "read", "coordinator")
        run(edge, "post", "a", "@b one more question?")
        run(edge, "close")
        assert json.loads(run(edge, "attention", "--json"))["items"] == []
        run(edge, "bind", "2" * 64, ok=False)
        # the turn ledger keeps the newest entries only
        ledger = run(name, "init", "Ledger").strip()
        state = saved(ledger)
        state["usage"] = {"tokens": {}, "turns": {("%064x" % n): True for n in range(2100)}}
        with open(os.path.join(ledger, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        run(ledger, "account", "f" * 64, "coordinator", "10")
        turns = saved(ledger)["usage"]["turns"]
        assert len(turns) == 2000 and "f" * 64 in turns and ("%064x" % 0) not in turns
        # --- concurrency
        race = run(name, "init", "Races").strip()
        run(race, "member", "w", "id=agent-w")

        def patch(change):
            state = saved(race)
            change(state["members"]["w"])
            with open(os.path.join(race, "members.json"), "w", encoding="utf-8") as f:
                json.dump(state, f)

        # failed wake attempts carry over to a newer mention: the member is reported, not counted from zero again
        run(race, "post", "coordinator", "@w first")
        patch(lambda w: w.update(wake_claim={"token": "x" * 32, "seq": 1, "attempts": 3, "until": 0}))
        run(race, "post", "coordinator", "@w second")
        assert run(race, "claim", "w", "agent-w", "2") == ""
        assert saved(race)["members"]["w"]["wake_claim"]["seq"] == 2
        assert [i["member"] for i in json.loads(run(race, "attention", "--json"))["items"] if i["kind"] == "unreachable"] == ["w"]
        run(race, "retry", "w")
        token = run(race, "claim", "w", "agent-w", "2").strip()
        assert len(token) == 32
        run(race, "woke", "w", "2", token)
        # a wake the clocks place inside the turn is not owed again at once, and is owed after the next turn whatever they say
        patch(lambda w: w["told"].update(at=time.time() + 3600))
        run(race, "rearm", "100", "agent-w")
        after = saved(race)["members"]["w"]
        assert after.get("last_nudged_seq") == 2 and after["told"].get("ended") is True
        run(race, "rearm", "100", "agent-w")
        after = saved(race)["members"]["w"]
        assert "last_nudged_seq" not in after and "ended" not in after["told"]
        # two conversations adopting one unowned run at the same moment: exactly one gets it
        for attempt in range(6):
            shared = run(name, "init", "Adopt %d" % attempt).strip()
            run(shared, "member", "solo-%d" % attempt)
            keys = [("%x" % (10 + attempt)) * 64, ("%x" % (4 + attempt % 2)) * 64]
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(lambda key: subprocess.run(
                    [sys.executable, BOARD, os.path.dirname(shared), "adopt", key, "solo-%d" % attempt],
                    capture_output=True, text=True), keys))
            won = [r for r in results if r.returncode == 0 and r.stdout.strip() == shared]
            assert len(won) == 1, [(r.returncode, r.stdout, r.stderr) for r in results]
            assert saved(shared)["binding"] in keys

        audit(os.path.join(tmp, "audit", ".swarm", "job"))

        # a read-only run folder can still be shown, an interrupted update in it included
        state = saved(edge)
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            state["pending_post"] = {"seq": len(f.readlines()) + 1, "agent": "coordinator", "text": "never appended",
                                     "time": "2026-11-18T10:00:00+0000", "to": []}
        with open(os.path.join(edge, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.chmod(os.path.join(edge, "board.jsonl"), 0o444)
        os.unlink(os.path.join(edge, ".lock"))  # so the lock itself cannot be created either
        os.chmod(edge, 0o555)
        try:
            assert "Edges" in run(edge, "status")
            assert "never appended" in run(edge, "show")
        finally:
            os.chmod(edge, 0o755)


def audit(name):
    """Regression checks, each in a run of its own under one parent."""
    def fresh(title):
        return run(name, "init", title).strip()

    def patch(d, member, change):
        state = saved(d)
        change(state["members"][member])
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)

    def kinds(d):
        return [item["kind"] for item in json.loads(run(d, "attention", "--json"))["items"]]

    # Wakes are counted per member until it reads, not per mention.
    wakes = fresh("Wakes")
    run(wakes, "member", "w", "id=agent-w")
    run(wakes, "post", "coordinator", "@w one")
    for _ in range(3):
        run(wakes, "woke", "w", "1", run(wakes, "claim", "w", "agent-w", "1").strip())
        run(wakes, "rearm", "0", "agent-w")
    assert "ignored" in kinds(wakes) and woken(wakes) == []
    run(wakes, "post", "coordinator", "@w two")
    assert "ignored" in kinds(wakes)  # a newer mention does not clear the flag
    run(wakes, "woke", "w", "2", run(wakes, "claim", "w", "agent-w", "2").strip())
    run(wakes, "rearm", "0", "agent-w")
    assert woken(wakes) == []  # and buys one wake, not three more
    # failed deliveries are reported as soon as a mention is owed, before anything tries to claim it
    patch(wakes, "w", lambda w: w.update(wake_claim={"token": "x" * 32, "seq": 2, "attempts": 3, "until": 0}))
    run(wakes, "post", "coordinator", "@w three")
    assert "unreachable" in kinds(wakes) and "(attempts exhausted)" in run(wakes, "wake")
    # a read shows the member is there: both counts start again, so the next mention is delivered
    run(wakes, "read", "w")
    after = saved(wakes)["members"]["w"]
    assert "wake_claim" not in after and "told" not in after
    run(wakes, "post", "coordinator", "@w four")
    assert len(run(wakes, "claim", "w", "agent-w", "4").strip()) == 32

    # A budget at or below what is already spent is refused: it could only stop the run at once, mid-work.
    money = fresh("Budget")
    run(money, "account", "1" * 64, "coordinator", "50")
    for under in ("40", "50"):
        refused = subprocess.run([sys.executable, BOARD, money, "limit", "budget=" + under], capture_output=True, text=True)
        assert refused.returncode and "already used 50 tokens" in refused.stderr, refused
    # and the budget stays the one every run starts with, so none is without a bound
    assert "(paused)" not in run(money, "status") and saved(money)["limits"] == {"budget": "3000000"}
    run(money, "limit", "budget=60")
    run(money, "pause", "awaiting a decision")
    run(money, "account", "2" * 64, "coordinator", "20")
    assert "token budget is spent (70 of 60)" in run(money, "attention")  # the pause names another reason
    # a turn that ends after the run closed is not added to it, and the caller still gets its JSON
    run(money, "close")
    late = json.loads(run(money, "account", "3" * 64, "coordinator", "500"))
    assert late == {"title": "Budget", "total": 70, "budget": 60, "paused": False}
    assert sum(saved(money)["usage"]["tokens"].values()) == 70

    # One-line summaries are capped, and a post longer than the page is cut, not refused.
    pages = fresh("Pages")
    run(pages, "member", "r")
    run(pages, "post", "coordinator", "x" * 5000)
    run(pages, "post", "coordinator", "@r " + "y" * 2000)
    first = run(pages, "read", "r", "--max-bytes=400")
    assert "x" * 200 + "…" in first and "x" * 201 not in first and "1 more post(s) remain" in first
    second = run(pages, "read", "r", "--max-bytes=400")
    assert "* #2" in second and "show --post=2" in second and len(second.encode()) < 500
    assert saved(pages)["members"]["r"]["last_read_seq"] == 2

    # The roster: protocol words after "@name:", dependencies, replacement and names.
    team = fresh("Roster")
    for member in ("base", "other"):
        run(team, "member", member)
    run(team, "member", "next", "depends=base", "group=crew")
    run(team, "post", "base", "@coordinator: READY base", ok=False)  # a colon after the mention hides no report
    run(team, "member", "base", "role=verifier", ok=False)  # @next would wait for it forever
    run(team, "replace", "base", "base-2", "role=verifier", ok=False)
    run(team, "member", "crew", ok=False)  # a group already answers to that name
    run(team, "replace", "other", "crew", ok=False)
    run(team, "member", "spec", "profile=architect", "writes=0")
    run(team, "post", "coordinator", stdin="@other @spec: BRIEF\nOwns: the shared layout")
    run(team, "replace", "spec", "spec-2", "profile=designer")
    assert "Owns: the shared layout" in run(team, "show", "spec-2") and saved(team)["members"]["spec-2"].get("writes") != "0"
    run(team, "member", "judge", "role=verifier")
    view = json.loads(run(team, "attention", "--json"))["members"]["judge"]
    assert (view["model"], view["effort"]) == ("sonnet", "medium")
    # a question mark in code, a URL or an optional type asks nothing
    run(team, "post", "base", "@other see `a?.b` and https://example.invalid/?q=1 where retries?: number")
    assert "question" not in kinds(team)
    run(team, "post", "base", "@other does `a?.b` hold?")
    assert "question" in kinds(team)
    # an investigator withdrawing a finding nobody confirmed wakes no verifier
    run(team, "member", "probe", "profile=investigator", "writes=0")
    run(team, "ready", "probe", stdin="a first idea")
    assert "-> @coordinator\n" in run(team, "revise", "probe", "not yet")
    # a worker taking its report back before anything is verified costs nobody a turn; a member waiting on it hears
    quiet = fresh("Quiet revise")
    for who, extra in (("first", []), ("second", ["depends=first"]), ("v", ["role=verifier"])):
        run(quiet, "member", who, *extra)
    run(quiet, "ready", "first", stdin="done")
    assert run(quiet, "revise", "first", "one more thing").splitlines()[0].endswith("-> @second")
    run(quiet, "member", "second", "depends=")
    run(quiet, "ready", "first", stdin="done again")
    assert run(quiet, "revise", "first", "and another").splitlines()[0].endswith("-> nobody")
    # `ready NAME HEAD` takes the commit from the checkout it runs in, so an isolated member needs no command substitution
    refused = subprocess.run([sys.executable, BOARD, quiet, "ready", "first", "HEAD"], input="done", text=True,
                             capture_output=True, cwd=os.path.dirname(quiet))
    assert refused.returncode != 0 and "HEAD is no commit here" in refused.stderr
    repo = os.path.join(os.path.dirname(os.path.dirname(quiet)), "head-repo")
    os.makedirs(repo)
    for args in (["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
                                  "commit", "-q", "--allow-empty", "-m", "one"]):
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)
    head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    took = subprocess.run([sys.executable, BOARD, quiet, "ready", "first", "HEAD"], input="done", text=True, capture_output=True, cwd=repo)
    assert took.returncode == 0, took.stderr
    with open(os.path.join(quiet, "board.jsonl"), encoding="utf-8") as f:
        assert json.loads(f.read().splitlines()[-1])["revision"] == head
    # HEAD of a checkout with edits in it is not what is being reported, and an inherited GIT_DIR does not redirect it
    with open(os.path.join(repo, "file"), "w") as f:
        f.write("one")
    subprocess.run(["git", "-C", repo, "add", "file"], check=True, capture_output=True)
    dirty = subprocess.run([sys.executable, BOARD, quiet, "ready", "first", "HEAD"], input="done", text=True, capture_output=True, cwd=repo)
    assert dirty.returncode != 0 and "uncommitted changes" in dirty.stderr
    subprocess.run(["git", "-C", repo, "reset", "-q", "--hard"], check=True, capture_output=True)
    astray = subprocess.run([sys.executable, BOARD, quiet, "ready", "first", "HEAD"], input="done", text=True, capture_output=True, cwd=repo,
                            env=dict(os.environ, GIT_DIR=os.path.join(os.path.dirname(quiet), "nowhere")))
    assert astray.returncode == 0, astray.stderr
    # a read-only member is told that first, wherever it stands
    run(quiet, "member", "scout", "profile=explorer", "writes=0")
    reader = subprocess.run([sys.executable, BOARD, quiet, "ready", "scout", "HEAD"], input="done", text=True, capture_output=True,
                            cwd=os.path.dirname(quiet))
    assert "read-only report cannot include a commit" in reader.stderr
    # a candidate that holds a member's work is dead once the member takes it back: its verifier and the coordinator
    # hear, mid-test or after VERIFIED; an accepted candidate, or one without this member, is nobody's concern
    record = os.path.join(quiet, "verification.json")
    for candidate, heard in (({"inputs": {"first": [1, None]}}, True), ({"inputs": {"first": [1, None]}, "accepted": True}, False),
                             ({"inputs": {"other": [1, None]}}, False)):
        run(quiet, "ready", "first", stdin="ready once more")
        with open(record, "w") as f:
            json.dump(candidate, f)
        line = run(quiet, "revise", "first", "again").splitlines()[0]
        assert ("@coordinator" in line and "@v" in line) == heard, (candidate, line)
    # rework by several workers after a failed candidate wakes the verifier when the last of them reports, not per piece
    run(quiet, "member", "third")
    for gone in ("second", "scout"):
        run(quiet, "member", gone, "killed=1")
    with open(record, "w") as f:
        json.dump({"inputs": {"first": [1, None], "third": [1, None]}}, f)
    assert "@v" not in run(quiet, "ready", "first", stdin="fixed").splitlines()[0]
    assert "@v" in run(quiet, "ready", "third", stdin="fixed too").splitlines()[0]
    os.unlink(record)
    # the plan says what the run has no guard against
    assert "no token budget" not in run(team, "plan")  # every run starts with one
    run(team, "limit", "budget=")
    plan = run(team, "plan")
    assert "no token budget" in plan and "@all wakes all" in plan
    run(team, "limit", "budget=1000")
    assert "no token budget" not in run(team, "plan")

    # Two runs this conversation owns with the same member: the refusal names them.
    key, parent = "a" * 64, os.path.dirname(team)
    for owned in (wakes, pages):
        run(owned, "member", "dup")
        run(owned, "bind", key)
    doubt = subprocess.run([sys.executable, BOARD, parent, "adopt", key, "dup"], capture_output=True, text=True)
    assert doubt.returncode == 3 and all(os.path.basename(owned) in doubt.stderr for owned in (wakes, pages)), doubt
    # a run does not change owner while an adoption is choosing one
    with open(os.path.join(parent, ".adopt.lock"), "w") as choosing:
        fcntl.flock(choosing, fcntl.LOCK_EX)
        try:
            subprocess.run([sys.executable, BOARD, team, "bind", "b" * 64], capture_output=True, timeout=1)
            raise AssertionError("bind did not wait for the adoption lock")
        except subprocess.TimeoutExpired:
            pass
    assert "binding" not in saved(team)

    # Resuming tells the members a pause stopped mid-work, and only those.
    halt = fresh("Resume")
    for who, extra in (("mid", ["id=agent-mid"]), ("done", ["id=agent-done"]), ("unborn", []), ("blocked", ["id=agent-b", "depends=unborn"]),
                        ("owed", ["id=agent-o"]), ("asker", ["id=agent-q"]), ("v", ["role=verifier", "id=agent-v"])):
        run(halt, "member", who, *extra)
    run(halt, "ready", "done", stdin="finished")
    run(halt, "post", "asker", "@coordinator which API version do you want?")
    run(halt, "post", "coordinator", "@owed take the second file too")
    def posted():
        with open(os.path.join(halt, "board.jsonl"), encoding="utf-8") as f:
            return sum(1 for _ in f)
    count = posted()
    run(halt, "resume")
    assert posted() == count  # a run that was not paused stopped nobody
    run(halt, "pause", "a question for the user")
    assert run(halt, "resume").splitlines()[0] == "posted #%d -> @mid" % (count + 1)
    assert "paused" not in saved(halt) and posted() == count + 1

    # Verification that keeps failing for one member is flagged at two cycles and pauses the run at three.
    loop = fresh("Rework")
    run(loop, "member", "a", "id=agent-a")
    run(loop, "member", "v", "role=verifier")
    run(loop, "post", "v", "@a NOT PASSED: the test fails")
    assert "rework" not in kinds(loop)
    run(loop, "post", "v", "@a NOT PASSED: it still fails")
    again = [item for item in json.loads(run(loop, "attention", "--json"))["items"] if item["kind"] == "rework"]
    assert [(item["member"], item["seq"]) for item in again] == [("a", 2)] and "paused" not in saved(loop)
    assert "paused: @a failed verification 3 times in a row" in run(loop, "post", "v", "@a NOT PASSED: and again")
    assert saved(loop)["paused"] == "@a failed verification 3 times in a row" and woken(loop) == []
    run(loop, "resume")
    run(loop, "post", "coordinator", "@a try the other approach")
    assert "paused" not in saved(loop) and woken(loop) == ["@a"]  # the same count does not pause it again
    run(loop, "post", "v", "@a NOT PASSED: no better")
    assert saved(loop)["paused"] == "@a failed verification 4 times in a row"
    state = saved(loop)
    state["accepted_seq"] = 5  # what verify.py records on acceptance
    with open(os.path.join(loop, "members.json"), "w", encoding="utf-8") as f:
        json.dump(state, f)
    assert "rework" not in kinds(loop)
    # one member with more than half of a run's tokens is named, once enough members have usage to compare
    state["usage"] = {"tokens": {"coordinator": 50000, hashlib.sha256(b"swarm-agent:agent-a").hexdigest(): 150000, "b" * 64: 50000}}
    for actors in (2, 3):
        with open(os.path.join(loop, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        share = [item for item in json.loads(run(loop, "attention", "--json"))["items"] if item["kind"] == "spend"]
        assert [(item["member"], item["text"]) for item in share] == (
            [("a", "@a has used 150,000 of the run's 260,000 tokens (57%)")] if actors == 3 else []), share
        state["usage"]["tokens"]["c" * 64] = 10000

    # prune archives closed runs nobody has touched, and only those
    plan = run(parent, "prune", "--days=0", "--dry-run")
    assert "would archive " + os.path.basename(money) in plan and "would remove 0 worktree(s) and archive 1 run(s)" in plan
    assert os.path.isdir(money)
    assert "archive " + os.path.basename(money) in run(parent, "prune", "--days=0")
    assert os.path.isfile(os.path.join(parent, "archive", os.path.basename(money), "members.json")) and not os.path.exists(money)
    assert os.path.isdir(loop) and run(parent, "prune", "--days=0").strip() == "remove 0 worktree(s) and archive 0 run(s)"
    run(parent, "prune", "--weeks=2", ok=False)
    # the run the `current` pointer names stays, closed or not: the pane of a conversation without a run shows it
    # closing with a pass the record no longer bears out says it is stale
    with open(os.path.join(loop, "verification.json"), "w") as f:
        json.dump({"candidate": "abc", "verified_by": "v"}, f)
    run(loop, "read", "coordinator")
    assert "abc, passed earlier, now stale" in run(loop, "close")
    with open(os.path.join(parent, "current")) as f:
        assert f.read().strip() == os.path.basename(loop)
    assert os.path.isdir(loop) and "archive 0 run(s)" in run(parent, "prune", "--days=0")
    # a run folder deleted by hand leaves the pointer naming nothing: prune takes the pointer away too
    shutil.rmtree(loop)
    assert "would remove the pointer" in run(parent, "prune", "--dry-run") and os.path.exists(os.path.join(parent, "current"))
    assert "remove the pointer to " + os.path.basename(loop) in run(parent, "prune")
    assert not os.path.exists(os.path.join(parent, "current"))


class BoardScenario(unittest.TestCase):
    """One end-to-end scenario against temporary run folders, so `python3 -m unittest discover` finds and runs it."""

    def test_scenario(self):
        scenario()


class BoardRegressions(unittest.TestCase):
    """Focused regression tests for board.py fixes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.swarm = os.path.join(self.root, ".swarm")

    def tearDown(self):
        self._tmp.cleanup()

    def init_run(self, name="reg"):
        return run(os.path.join(self.swarm, name), "init", "Regression").strip()

    def test_attention_counts_posts_over_the_whole_journal(self):
        d = self.init_run()
        run(d, "member", "w")
        for _ in range(3):
            run(d, "post", "coordinator", stdin="@w next step")
        run(d, "read", "w")
        run(d, "post", "coordinator", stdin="@w one more")
        run(d, "post", "w", stdin="@coordinator done")
        report = json.loads(run(d, "attention", "--json"))
        assert report["sent"] == {"coordinator": 4, "w": 1}, report["sent"]
        assert report["unread"]["w"] == 1, report["unread"]

    def test_run_folder_is_private_under_a_permissive_umask(self):
        before = os.umask(0o022)
        try:
            d = self.init_run()
            assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
            os.chmod(d, 0o755)  # a run made before runs were private
            run(d, "show")
            assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
            elsewhere = os.path.join(self.root, "copy")  # a run folder copied out of .swarm is not chmodded
            shutil.copytree(d, elsewhere)
            os.chmod(elsewhere, 0o755)
            run(elsewhere, "show")
            assert stat.S_IMODE(os.stat(elsewhere).st_mode) == 0o755
        finally:
            os.umask(before)

    def test_scope_change_withdraws_reports_and_rechecks_dependents(self):
        d = self.init_run()
        run(d, "member", "w", "paths=src")
        run(d, "member", "follower", "depends=w")
        run(d, "ready", "w", stdin="done")
        run(d, "ready", "follower", stdin="done")
        def readiness():
            team = json.loads(run(d, "attention", "--json"))["members"]
            return [team[n]["ready"] for n in ("w", "follower")]
        run(d, "member", "w", "paths=./src/", "id=address")
        assert readiness() == [True, True]
        run(d, "member", "w", "paths=src,tests")
        assert readiness() == [False, False]
        run(d, "ready", "w", stdin="covered tests")
        assert readiness() == [True, False]
        run(d, "ready", "follower", stdin="rechecked")
        assert readiness() == [True, True]

    def test_verifier_wakes_only_for_current_combined_reports(self):
        d = self.init_run()
        run(d, "member", "upstream", "profile=investigator")
        run(d, "member", "w", "depends=upstream")
        run(d, "member", "v", "role=verifier")
        for _ in range(2):
            finding = run(d, "ready", "upstream", stdin="observed").split()[1][1:]
            assert "@v" not in run(d, "confirm", "upstream", finding)
            assert "@v" in run(d, "ready", "w", stdin="checked")

    def test_read_only_reader_leaves_journal_repair_to_writer(self):
        from pathlib import Path
        d = self.init_run()
        journal = Path(d) / "board.jsonl"
        lock = Path(d) / ".lock"
        run(d, "status")  # create the same lock a writer uses
        journal.write_bytes(b'{"seq":')
        lock.chmod(0o444)
        try:
            if os.access(lock, os.W_OK):
                self.skipTest("test requires a user subject to file permissions")
            run(d, "status")
            assert journal.read_bytes() == b'{"seq":'
        finally:
            lock.chmod(0o644)
        run(d, "status")
        assert journal.read_bytes() == b""

    def test_retired_address_cannot_bind_a_successor(self):
        d = self.init_run()
        run(d, "member", "old", "id=address")
        run(d, "replace", "old", "new", "id=address", ok=False)
        assert not saved(d)["members"]["old"].get("killed")
        run(d, "replace", "old", "new")
        run(d, "started", "new", "address", "", ok=False)
        run(d, "started", "new", "new-address", "")

    def test_family_inherit_warns_when_limit_active(self):
        d = self.init_run()
        run(d, "limit", "opus=architect")
        res = subprocess.run([sys.executable, BOARD, d, "member", "w", "model=inherit"],
                             capture_output=True, text=True, check=True)
        assert "note: @w has model=inherit" in res.stderr

    def test_bind_validates_before_lock_and_prints_path(self):
        fake = os.path.join(self.root, "not-swarm")
        os.makedirs(fake)
        with open(os.path.join(fake, "members.json"), "w", encoding="utf-8") as f:
            json.dump({"title": "x", "members": {"coordinator": {"role": "coordinator", "last_read_seq": 0}}}, f)
        run(fake, "bind", "a" * 64, ok=False)
        assert not os.path.exists(os.path.join(self.root, ".adopt.lock"))
        assert not os.path.exists(os.path.join(fake, ".lock"))
        d = self.init_run()
        assert run(d, "bind", "a" * 64).strip() == os.path.abspath(d)

    def test_tail_exact_boundary_and_oversized_final_line(self):
        d = self.init_run()
        board_path = os.path.join(d, "board.jsonl")
        line1 = b'{"seq":1,"agent":"a","text":"first","time":"2026-01-01T00:00:00+0000"}\n'
        line2 = b'{"seq":2,"agent":"a","text":"second","time":"2026-01-01T00:00:01+0000"}\n'
        with open(board_path, "wb") as f:
            f.write(line1 + line2)
        out = subprocess.run([sys.executable, BOARD, d, "tail", str(len(line2))],
                             capture_output=True, check=True).stdout
        assert out == line2
        res = subprocess.run([sys.executable, BOARD, d, "tail", str(len(line2) - 1)],
                             capture_output=True, text=True)
        assert res.returncode != 0 and "exceeds byte budget" in res.stderr

    def test_show_post_json(self):
        d = self.init_run()
        run(d, "member", "w")
        run(d, "post", "coordinator", "@w hello")
        raw = json.loads(run(d, "show", "--post=1", "--json"))
        assert raw["seq"] == 1 and raw["agent"] == "coordinator" and raw["text"] == "@w hello"
        run(d, "show", "--json", ok=False)

    def test_retire_and_rerole_under_over_limits(self):
        d = self.init_run()
        for name in ("w1", "w2", "w3", "w4"):
            run(d, "member", name)
        run(d, "limit", "max_workers=2", "max_members=3")
        run(d, "member", "w5", ok=False)
        run(d, "member", "w4", "killed=1")
        run(d, "member", "w3", "role=verifier")
        run(d, "replace", "w2", "w2v", "role=verifier")
        assert saved(d)["members"]["w4"]["killed"] == "1"
        assert saved(d)["members"]["w2v"]["role"] == "verifier"

    def test_mentions_strip_quoted_and_ascii_boundaries(self):
        d = self.init_run()
        run(d, "member", "worker")
        assert "nobody" in run(d, "post", "coordinator", "Do not use ``@all`` or `@worker` or ```\n@worker\n```")
        assert "-> @worker" in run(d, "post", "coordinator", "请@worker看 @worker请看")
        run(d, "post", "coordinator", "@worker a ?? b and x ? y : z")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

    def test_stale_includes_readonly_and_confirmed_subject(self):
        d = self.init_run()
        run(d, "member", "exp", "profile=explorer", "writes=0")
        run(d, "member", "inv", "profile=investigator", "writes=0")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "exp", stdin="explored")
        seq = run(d, "ready", "inv", stdin="found").split()[1].lstrip("#")
        run(d, "confirm", "inv", seq)
        with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
            json.dump({"candidate": "abc", "project": self.root, "path": self.root, "mode": "shared",
                       "commit": None, "checks": ["true"], "no_checks": False,
                       "inputs": {"exp": [1, None], "inv": [3, None]}, "digest": "deadbeef",
                       "verified_by": "v", "accepted": True}, f)
        with open(os.path.join(d, "board.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"seq": 4, "agent": "v", "text": "@coordinator VERIFIED abc deadbeef",
                                "time": "2026-01-01T00:00:00+0000", "to": ["coordinator"]}) + "\n")
        run(d, "revise", "exp", "missed a file")
        stale = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "stale"]
        assert stale and "@exp's change" in stale[0]["text"]

    def test_resume_wakes_consultant_and_verifier(self):
        d = self.init_run()
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1", "id=id-adv")
        run(d, "member", "v", "role=verifier", "id=id-v")
        state = saved(d)
        state["members"]["v"]["told"] = {"seq": 1, "at": 1.0, "times": 1, "ended": True}
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        run(d, "pause", "hold")
        out = run(d, "resume")
        assert "@adv" in out and "@v" in out

    def test_native_agent_run_and_started_clears_state(self):
        d1 = self.init_run("job")
        key = "c" * 64
        run(d1, "bind", key)
        run(d1, "member", "w", "id=teammate-1")
        run(d1, "close")
        d2 = self.init_run("job")
        run(d2, "bind", key)
        run(d2, "member", "w", "id=teammate-1")
        assert run(self.swarm, "agent-run", key, "teammate-1").strip() == os.path.abspath(d2)
        state = saved(d2)
        state["members"]["w"]["wake_claim"] = {"token": "t", "seq": 1, "attempts": 3, "until": 9999999999}
        state["members"]["w"]["last_nudged_seq"] = 1
        state["members"]["w"]["told"] = {"seq": 1, "at": 1.0, "times": 3}
        with open(os.path.join(d2, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        run(d2, "started", "w", "teammate-1", "teammate-1")
        w = saved(d2)["members"]["w"]
        assert "wake_claim" not in w and "last_nudged_seq" not in w and "told" not in w

    def test_ready_targets_report_mentions_and_consultant_skips_verifier(self):
        d = self.init_run()
        run(d, "member", "des", "profile=designer")
        run(d, "member", "ui")
        run(d, "member", "v", "role=verifier")
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1")
        out_des = run(d, "ready", "des", stdin="Spec ready.\nNeeds from others: @ui wire button")
        # the member the report names hears at once; the verifier hears when the last worker is ready
        assert "@ui" in out_des and "@v" not in out_des
        assert "@v" in run(d, "ready", "ui", stdin="Button wired.")
        out_adv = run(d, "ready", "adv", stdin="Advice ready")
        assert "@v" not in out_adv and "@coordinator" in out_adv

    def test_blocked_skips_ready_dep_and_flags_ignored(self):
        d = self.init_run()
        run(d, "member", "a", "id=id-a")
        run(d, "member", "b", "depends=a", "id=id-b")
        run(d, "post", "coordinator", "@a start")
        state = saved(d)
        state["members"]["a"]["told"] = {"seq": 1, "at": 1.0, "times": 3}
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        blocked = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "blocked"]
        assert blocked and "ignoring its mentions" in blocked[0]["text"]
        run(d, "ready", "a", stdin="done")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "blocked"]

    def test_nondict_json_guards_and_broken_symlink_prune(self):
        d = self.init_run()
        key = "d" * 64
        run(d, "bind", key)
        run(d, "close")
        with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
            f.write("null")
        os.symlink("/nonexistent/target", os.path.join(d, "broken"))
        self.init_run("cur")
        assert "archive 1 run(s)" in run(self.swarm, "prune", "--days=0", "--dry-run")
        d2 = self.init_run()
        run(d2, "bind", key)
        with open(os.path.join(d2, "members.json"), "w", encoding="utf-8") as f:
            f.write("[]")
        assert run(self.swarm, "restore", key).strip() == ""

    def test_adopt_hint_closed_run_and_locate_readonly(self):
        d1 = self.init_run("job")
        run(d1, "member", "w")
        run(d1, "close")
        d2 = self.init_run("job")
        run(d2, "member", "w")
        key = "e" * 64
        hint = f"Run {os.path.basename(d2)} replaces {os.path.basename(d1)}"
        os.chmod(self.swarm, 0o555)
        try:
            assert run(self.swarm, "locate", key, "w", hint).strip() == os.path.abspath(d2)
        finally:
            os.chmod(self.swarm, 0o755)
        assert run(self.swarm, "adopt", key, "w", hint).strip() == os.path.abspath(d2)

    def test_clear_specialist_profile_and_depends_dedup_consult(self):
        d = self.init_run()
        run(d, "member", "e", "profile=explorer")
        assert saved(d)["members"]["e"]["writes"] == "0"
        run(d, "member", "e", "profile=")
        assert "writes" not in saved(d)["members"]["e"]
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1")
        run(d, "member", "w", "depends=e,e")
        assert saved(d)["members"]["w"]["depends"] == "e"
        run(d, "member", "w", "depends=adv", ok=False)
        run(d, "member", "e", "profile=architect", "writes=0", "consult=1", ok=False)

    def test_replace_preserves_unanswered_and_checks_self_group(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "post", "a", "@b which port?")
        run(d, "read", "b")  # b read #1 without answering
        run(d, "replace", "b", "c", "group=c", ok=False)
        run(d, "replace", "b", "c")
        assert "#1" in run(d, "show", "--post=2")
        qs = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        assert qs and qs[0]["member"] == "c"
        run(d, "post", "c", "@a re #1: 8080")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

    def test_wake_lease_woke_rearm_closed_and_overflow(self):
        d = self.init_run()
        run(d, "member", "w", "id=id-w")
        run(d, "post", "coordinator", "@w go")
        for _ in range(3):
            tok = run(d, "claim", "w", "id-w", "1").strip()
            if _ < 2:
                state = saved(d)
                state["members"]["w"]["wake_claim"]["until"] = 0
                with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
                    json.dump(state, f)
        assert "(attempts exhausted)" not in run(d, "wake")
        run(d, "rearm", "9" * 400, "id-w", ok=False)
        run(d, "read", "coordinator")
        run(d, "read", "w")
        run(d, "close")
        run(d, "woke", "w", "1", tok)  # no-op on closed run
        run(d, "rearm", "1000", "id-w")  # no-op on closed run

    def test_read_brief_two_lines_and_all_headers_conflict(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "post", "coordinator", stdin="@a BRIEF\nOwns: src/a.py")
        out = run(d, "read", "b")
        assert "@a BRIEF | Owns: src/a.py" in out
        run(d, "read", "b", "--all", "--headers", ok=False)

    def test_post_finding_guard_and_revise_error(self):
        d = self.init_run()
        run(d, "member", "inv", "profile=investigator")
        run(d, "post", "inv", "@coordinator FINDING it broke", ok=False)
        run(d, "member", "w")
        run(d, "post", "w", "@coordinator FINDING prose note")
        err = subprocess.run([sys.executable, BOARD, d, "post", "w", "@coordinator REVISE nope"],
                             capture_output=True, text=True).stderr
        assert "revise w <reason>" in err

    def test_low_polish_closed_view_model_retry_limit_clear(self):
        d = self.init_run()
        run(d, "member", "w", "model=opsu", ok=False)
        run(d, "member", "w")
        run(d, "limit", "fable=architect")
        assert "fable" in saved(d)["limits"]
        run(d, "limit", "fable=")
        assert "fable" not in saved(d)["limits"]
        run(d, "limit", "fable=none")
        assert saved(d)["limits"]["fable"] == "none"
        run(d, "retry", "coordinator", ok=False)
        run(d, "member", "w", "killed=1")
        run(d, "retry", "w", ok=False)
        run(d, "close")
        rep = json.loads(run(d, "attention", "--json"))
        assert not rep["members"]["w"]["unreachable"] and rep["members"]["w"]["blocked_on"] == []

    def test_quoted_and_question_regex_edge_cases(self):
        d = self.init_run()
        run(d, "member", "other")
        run(d, "member", "asker")
        run(d, "post", "asker", "@other see `a?.b` and https://example.invalid/?q=1 where retries?: number")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        run(d, "post", "asker", "@other did you check http://localhost:8080?")
        qs = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        assert len(qs) == 1
        run(d, "post", "other", "@asker re #2: yes")
        run(d, "post", "asker", stdin="@other should we use A?\nOption A : yes")
        qs = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        assert len(qs) == 1

    def test_resume_after_not_passed_and_worker_told_ended(self):
        d = self.init_run()
        run(d, "member", "w", "id=id-w")
        run(d, "member", "w2", "id=id-w2")
        run(d, "member", "v", "role=verifier", "id=id-v")
        run(d, "ready", "w", stdin="done")
        run(d, "ready", "w2", stdin="done")
        for _ in range(3):
            run(d, "post", "v", "@w NOT PASSED: fails")
        assert saved(d).get("paused")
        # Both w and w2 are ready (with seq < verified_seq of NOT PASSED), so resuming after NOT PASSED must not wake v
        out1 = run(d, "resume")
        assert "@v" not in out1
        # w withdraws readiness and has an unread mention, but its turn ended with told.ended == True during a pause
        run(d, "revise", "w", "fixing")
        state = saved(d)
        state["members"]["w"]["told"] = {"seq": 5, "at": 1.0, "times": 1, "ended": True}
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        run(d, "pause", "hold")
        out2 = run(d, "resume")
        assert "@w" in out2 and "@v" not in out2

    def test_ready_consultant_mentions_and_verifier_prose_mention(self):
        d = self.init_run()
        run(d, "member", "w1")
        run(d, "member", "w2")
        run(d, "member", "v", "role=verifier")
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1")
        # w1 ready mentioning @v while w2 is still working must not wake @v early
        out_w1 = run(d, "ready", "w1", stdin="Ready for @v once @w2 finishes")
        assert "@v" not in out_w1 and "@w2" in out_w1
        # consultant ready mentioning @w2 or @v only notifies @coordinator
        out_adv = run(d, "ready", "adv", stdin="Recommendation for @w2 and @v")
        assert out_adv.splitlines()[0].endswith("-> @coordinator")

    def test_rework_attributes_first_line_workers_only(self):
        d = self.init_run()
        run(d, "member", "w1")
        run(d, "member", "des", "profile=designer")
        run(d, "member", "v", "role=verifier")
        for i in range(3):
            out = run(d, "post", "v", stdin=f"@w1 NOT PASSED: failure {i}\nCompared against @des spec")
        assert saved(d).get("paused") == "@w1 failed verification 3 times in a row"
        items = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "rework"]
        assert [i["member"] for i in items] == ["w1"]

    def test_fable_investigator_validation_bypass_closed(self):
        d = self.init_run()
        run(d, "member", "inv", "profile=investigator")
        # Setting model=fable with profile=investigator on new or existing Opus investigator is rejected
        run(d, "member", "inv", "model=fable", "effort=medium", ok=False)
        run(d, "member", "w", "model=fable")
        run(d, "member", "w", "profile=investigator", ok=False)
        run(d, "replace", "inv", "inv2", "model=fable", "effort=medium")
        # Once escalated via replace, updating other fields works, but changing effort away from medium is rejected
        run(d, "member", "inv2", "id=id-inv2")
        run(d, "member", "inv2", "effort=high", ok=False)
        run(d, "member", "inv2", "id=id-inv2b", "effort=high", ok=False)

    def test_paths_refuse_a_second_writer_and_pass_to_a_successor(self):
        with tempfile.TemporaryDirectory() as t:
            d = run(os.path.join(t, ".swarm", "claims"), "init", "Claims").strip()

            def refused(*args):
                r = subprocess.run([sys.executable, BOARD, d, *args], capture_output=True, text=True)
                assert r.returncode != 0, (args, r.stdout)
                return r.stderr
            run(d, "member", "feed", "paths=./Sources/Feed/,Tests/LifecycleSuite.swift")
            assert saved(d)["members"]["feed"]["paths"] == "Sources/Feed,Tests/LifecycleSuite.swift"
            # the same file, a file inside a claimed folder, and a folder holding a claimed file are all refused
            for taken in ("Tests/LifecycleSuite.swift", "Sources/Feed/Parser.swift", "Tests"):
                clash = refused("member", "widgets", "paths=Sources/Widgets," + taken)
                assert "@widgets and @feed both claim" in clash and "widgets" not in saved(d)["members"]
            run(d, "member", "widgets", "paths=Sources/Widgets,Sources/FeedKit")  # a name that only starts alike is another folder
            assert "relative to the project folder" in refused("member", "other", "paths=/etc/hosts")
            assert "relative to the project folder" in refused("member", "other", "paths=../outside")
            # a reader claims nothing, and a retired member's paths are free again
            run(d, "member", "scout", "profile=explorer", "paths=Sources/Feed")
            refused("member", "widgets", "paths=Sources/Feed")
            run(d, "post", "coordinator", "@feed BRIEF\nOwns: the feed")
            run(d, "replace", "feed", "feed-2")
            assert saved(d)["members"]["feed-2"]["paths"] == "Sources/Feed,Tests/LifecycleSuite.swift"
            assert "@widgets and @feed-2 both claim" in refused("member", "widgets", "paths=Sources/Feed")
            run(d, "member", "feed-2", "killed=1")
            run(d, "member", "widgets", "paths=Sources/Feed")

    def test_coordinator_ruling_settles_a_question_put_to_several(self):
        d = self.init_run()
        for name in ("screens", "lead", "other"):
            run(d, "member", name)
        asked = lambda: [(i["member"], i["seq"]) for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        run(d, "post", "screens", "@lead @coordinator which toolbar do the boards use?")
        assert len(asked()) == 2
        # a peer's reply answers for itself only
        run(d, "post", "other", "@screens re #1 I would guess the Today one")
        assert len(asked()) == 2
        # the coordinator rules on it: the member asked in the same post owes no second answer
        run(d, "post", "coordinator", "@screens re #1 ruling: Today's toolbar")
        assert asked() == []
        # a ruling on one question leaves another to the same member open, and numbers may be listed with spaces
        run(d, "post", "screens", "@lead which band colours?")
        run(d, "post", "screens", "@lead and which corner radius?")
        run(d, "post", "coordinator", "@screens re #4 the app's colours")
        assert [seq for _, seq in asked()] == [5]
        run(d, "post", "lead", "@screens FROZEN (re #4 #5): colours and radius are in the spec")
        assert asked() == []

    def test_replace_brief_and_open_questions_follow_the_chain(self):
        d = self.init_run()
        for name in ("a", "asker", "other"):
            run(d, "member", name)
        run(d, "post", "coordinator", stdin="@other BRIEF\nSee also @a for the parser.")
        run(d, "post", "coordinator", stdin="@a @other BRIEF | Owns: the parser\nDone when: it parses")
        run(d, "post", "coordinator", stdin="@a BRIEF\nOwns: the lexer")
        run(d, "post", "coordinator", stdin="@other BRIEF\nThe lexer is @a's.")
        run(d, "post", "asker", "@a which grammar?")
        run(d, "replace", "a", "b")
        brief = run(d, "show", "b")
        assert "Owns: the lexer" in brief and "The lexer is" not in brief
        # a one-line brief keeps its text after BRIEF
        run(d, "post", "coordinator", stdin="@b BRIEF Owns: one line")
        run(d, "replace", "b", "c")
        assert "Owns: one line" in run(d, "show", "c")
        # a question the retired member read and never answered is listed for its successor
        run(d, "member", "x")
        seq = re.search(r"#(\d+)", run(d, "post", "asker", "@x which file?")).group(1)
        run(d, "read", "x")
        run(d, "member", "x", "killed=1")
        run(d, "replace", "x", "y")
        assert "yours to answer: #%s." % seq in run(d, "show", "y")

    def test_replace_carries_shared_briefs_above_the_own_one(self):
        d = self.init_run()
        for name in ("parser", "lexer", "currency"):
            run(d, "member", name)
        run(d, "post", "coordinator", stdin="@parser @currency BRIEF\nShared: the money type")
        run(d, "post", "coordinator", stdin="@parser BRIEF\nOwns: the parser")
        run(d, "post", "coordinator", stdin="@lexer BRIEF\nOwns: the lexer")
        run(d, "post", "coordinator", stdin="@lexer @currency BRIEF\nShared: the token stream")
        run(d, "replace", "parser", "parser-2")
        brief = run(d, "show", "parser-2")
        assert brief.index("Shared brief #1: Shared: the money type") < brief.index("Owns: the parser"), brief
        # a shared brief posted after the own one does not take its place
        run(d, "replace", "lexer", "lexer-2")
        brief = run(d, "show", "lexer-2")
        assert "Shared brief #4: Shared: the token stream" in brief and "Owns: the lexer" in brief, brief
        run(d, "replace", "currency", "currency-2")
        brief = run(d, "show", "currency-2")
        assert brief.index("Shared brief #1:") < brief.index("Shared brief #4:") and "had no brief" not in brief, brief
        assert brief.count("the token stream") == 1, brief  # a shared brief does not also stand in as the own one
        # the successor inherits the group, yet a brief to a group of one stays that member's own
        run(d, "member", "solo", "group=crew")
        run(d, "post", "coordinator", stdin="@crew BRIEF\nOwns: the crew work")
        run(d, "replace", "solo", "solo-2")
        assert "Shared brief" not in run(d, "show", "solo-2")

    def test_ready_wakes_a_dependent_once_it_can_start(self):
        d = self.init_run()
        for name, extra in (("alpha", []), ("beta", []), ("joiner", ["depends=alpha,beta"]),
                            ("named", ["depends=alpha,beta"]), ("bystander", [])):
            run(d, "member", name, "id=agent-" + name, *extra)
        first = run(d, "ready", "alpha", stdin="done\nchecked\nalpha detail @named @bystander")
        # a mention always reaches its member, a dependent or not
        assert "@joiner" not in first and "@named" in first and "@bystander" in first, first
        assert "@joiner" not in woken(d)
        assert "@joiner" in run(d, "ready", "beta", stdin="done\nchecked\nbeta detail")
        assert woken(d).count("@joiner") == 1
        out = run(d, "read", "joiner")
        assert "alpha detail" in out and "beta detail" in out, out
        # the same gate holds for a confirmed finding
        run(d, "member", "probe", "profile=investigator", "writes=0")
        run(d, "member", "late")
        run(d, "member", "fixer", "depends=probe,late")
        run(d, "member", "solo", "depends=probe")
        finding = run(d, "ready", "probe", stdin="observed").split()[1][1:]
        confirmed = run(d, "confirm", "probe", finding)
        assert "@fixer" not in confirmed and "@solo" in confirmed, confirmed
        assert "@fixer" in run(d, "ready", "late", stdin="done")

    def test_verifier_reads_each_current_ready_in_full(self):
        d = self.init_run()
        for name, extra in (("w1", []), ("w2", []), ("v", ["role=verifier"])):
            run(d, "member", name, *extra)
        run(d, "ready", "w1", stdin="done\nchecked\nw1 first")
        run(d, "ready", "w1", stdin="done\nchecked\nw1 second")
        run(d, "ready", "w2", stdin="done\nchecked\nw2 detail")
        out = run(d, "read", "v")
        assert "w1 second" in out and "w2 detail" in out and "w1 first" not in out, out

    def test_read_replays_needed_reports_the_reader_passed(self):
        d = self.init_run()
        for name, extra in (("w1", []), ("w2", []), ("late", []), ("dep", ["depends=w1,w2"])):
            run(d, "member", name, *extra)
        run(d, "ready", "w1", stdin="done\nchecked\nw1 first")
        run(d, "ready", "w1", stdin="done\nchecked\nw1 second")
        run(d, "ready", "w2", stdin="done\nchecked\nw2 detail")
        # registered after the reports: each current one in full on the first read, a replaced one never, then no more
        run(d, "member", "v", "role=verifier")
        out = run(d, "read", "v")
        assert "w1 second" in out and "w2 detail" in out and "w1 first" not in out, out
        assert run(d, "read", "v") == "no new posts\n"
        # a dependency added after its READY was read as a summary
        assert "w1 second" not in run(d, "read", "late")
        run(d, "member", "late", "depends=w1")
        out = run(d, "read", "late")
        assert "w1 second" in out and "w2 detail" not in out, out
        assert "w1 second" not in run(d, "read", "late")
        # a successor gets its dependencies' current reports
        run(d, "replace", "dep", "dep-2")
        out = run(d, "read", "dep-2")
        assert "w1 second" in out and "w2 detail" in out and "w1 first" not in out, out

    def test_read_replay_is_paged_and_keeps_the_cursor(self):
        d = self.init_run()
        for name in ("w1", "w2"):
            run(d, "member", name)
            run(d, "ready", name, stdin="done\nchecked\n%s detail %s" % (name, "x" * 250))
        run(d, "member", "v", "role=verifier")
        cursor = saved(d)["members"]["v"]["last_read_seq"]
        run(d, "post", "coordinator", "@v hello")
        out = run(d, "read", "v", "--max-bytes=400")
        assert "w1 detail" in out and "w2 detail" not in out and "hello" not in out and "remain" in out, out
        assert saved(d)["members"]["v"]["last_read_seq"] == cursor
        out = run(d, "read", "v", "--max-bytes=400")
        assert "w2 detail" in out and "w1 detail" not in out and "hello" in out, out
        assert saved(d)["members"]["v"]["last_read_seq"] == cursor + 1
        assert run(d, "read", "v", "--max-bytes=400") == "no new posts\n"

    def test_read_attention_fits_the_page(self):
        d = self.init_run()
        for i in range(6):
            run(d, "member", "q%d" % i)
            run(d, "post", "q%d" % i, "@coordinator which file?")
        run(d, "member", "z")
        run(d, "read", "coordinator")
        run(d, "post", "z", "@coordinator ok")
        out = run(d, "read", "coordinator", "--attention", "--max-bytes=256")
        assert "6 item(s) need attention" in out and "[question]" not in out and "attention" in out.splitlines()[-1], out
        assert saved(d)["members"]["coordinator"]["last_read_seq"] == 7

    def test_kill_ends_any_run_at_once(self):
        d = self.init_run()
        run(d, "member", "w", "id=agent-w", "isolated=1")
        run(d, "member", "spare")
        run(d, "member", "v", "role=verifier", "id=agent-v")
        run(d, "post", "w", "@coordinator which file?")
        run(d, "post", "coordinator", "@w @v go")
        run(d, "claim", "w", "agent-w", "2")
        run(d, "pause", "waiting on the user")
        run(d, "close", ok=False)  # unread posts hold `close`, never `kill`
        out = run(d, "kill", "wrong", "repo")
        assert out == "killed: 3 member(s) retired, run closed\n@w agent-w\n@v agent-v\n", out
        roster = saved(d)
        assert roster["closed"] is True and roster["killed"] == "wrong repo" and "paused" not in roster
        w = roster["members"]["w"]
        assert w["killed"] == "1" and w["id"] == "agent-w" and w["isolated"] == "1" and "wake_claim" not in w, w
        last = run(d, "show", "--post=3", "--json")
        post = json.loads(last)
        assert post["text"] == "SHUTDOWN\nThe user killed the run: wrong repo" and post["to"] == [], post
        assert roster["members"]["coordinator"]["last_read_seq"] == 3
        assert run(d, "read", "coordinator") == "no new posts\n"
        assert run(d, "wake") == "" and run(d, "claim", "v", "agent-v", "3") == ""
        assert json.loads(run(d, "attention", "--json"))["items"] == []
        run(d, "status")
        run(d, "export")
        for command in (["post", "w", "late"], ["ready", "w"], ["member", "x"], ["resume"]):
            run(d, *command, ok=False)
        assert run(d, "kill") == "already closed\n"
        assert saved(d) == roster

    def test_kill_retires_members_a_close_left_running(self):
        from pathlib import Path
        d = self.init_run()
        run(d, "member", "w", "id=agent-w")
        run(d, "close")
        board = Path(d, "board.jsonl").read_text()
        assert run(d, "kill") == "killed: 1 member(s) retired, run closed\n@w agent-w\n"
        roster = saved(d)
        assert roster["members"]["w"]["killed"] == "1" and roster["killed"] == "killed by the user"
        assert Path(d, "board.jsonl").read_text() == board  # a closed board gets no post
        assert run(d, "kill") == "already closed\n" and saved(d) == roster

    def test_headers_read_leaves_an_addressed_ready_to_replay(self):
        d = self.init_run()
        for name, extra in (("w1", []), ("w2", []), ("v", ["role=verifier"])):
            run(d, "member", name, *extra)
        run(d, "ready", "w1", stdin="done\nchecked\nw1 detail")
        run(d, "ready", "w2", stdin="done\nchecked\nw2 detail")  # completes the team, so it is addressed to @v
        assert "detail" not in run(d, "read", "v", "--headers")
        out = run(d, "read", "v")
        assert "w1 detail" in out and "w2 detail" in out, out
        assert run(d, "read", "v") == "no new posts\n"

    def test_a_bare_number_or_a_lone_citation_settles_a_question(self):
        d = self.init_run()
        for name in ("api", "parser", "other"):
            run(d, "member", name)

        def asked():
            return [i["seq"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

        def seq(out):
            return int(re.search(r"#(\d+)", out).group(1))

        q = seq(run(d, "post", "parser", "@api which port?"))
        run(d, "post", "api", "@parser Thanks #%d, 8080" % q)
        assert asked() == []
        q = seq(run(d, "post", "parser", "@api which host?"))
        assert "-> nobody" in run(d, "post", "api", "re #%d: localhost" % q)  # settles, and wakes nobody
        assert asked() == []
        # a bare number from anyone who was not asked cites nothing, the asker's included
        q = seq(run(d, "post", "parser", "@api which user?"))
        run(d, "post", "parser", "@other we wait on #%d" % q)
        run(d, "post", "other", "@parser see #%d" % q)
        run(d, "post", "api", "@parser started")
        assert asked() == [q]

    def test_only_a_cited_reply_settles_a_question(self):
        d = self.init_run()
        for name in ("api", "parser", "currency"):
            run(d, "member", name)

        def asked():
            return [i["seq"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

        def seq(out):
            return int(re.search(r"#(\d+)", out).group(1))

        q = seq(run(d, "post", "parser", "@api Which field carries the revision?"))
        out = run(d, "post", "api", "@parser I have started the integration test.")
        assert asked() == [q] and "OPEN: #%d from @parser still open to you" % q in out and "just `re #%d`" % q in out, out
        assert "OPEN" not in run(d, "post", "api", "@currency a note")  # not to the asker
        assert "OPEN" not in run(d, "post", "coordinator", "@api a note")  # nothing was put to the coordinator
        out = run(d, "post", "api", "@parser re #%d: the rev field" % q)
        assert asked() == [] and "OPEN" not in out, out
        # a question put to the coordinator is the coordinator's to cite
        q = seq(run(d, "post", "parser", "@coordinator may I edit lib/?"))
        assert "OPEN: #%d from @parser" % q in run(d, "post", "coordinator", "@parser later")
        run(d, "post", "coordinator", "@parser re #%d: yes" % q)
        # the asker withdraws its own question by citing it
        q = seq(run(d, "post", "parser", "@api and the base?"))
        run(d, "post", "parser", "re #%d: moot now" % q)
        assert asked() == []
        # the coordinator's ruling settles it for everyone it was put to
        q = seq(run(d, "post", "parser", "@api @currency which format?"))
        assert asked() == [q, q]
        run(d, "post", "coordinator", "@parser re #%d: ISO" % q)
        assert asked() == []
        # an uncited post leaves the question to the successor
        q = seq(run(d, "post", "parser", "@api which port?"))
        run(d, "read", "api")  # read, so only the open question carries it over
        run(d, "post", "api", "@parser starting")
        run(d, "replace", "api", "api-2")
        assert ("#%d" % q) in run(d, "show", "api-2").split("yours to answer: ")[1].split(".")[0].split()

    def test_coordinator_reads_a_reviewed_ready_as_its_summary(self):
        d = self.init_run()
        for name, extra in (("w1", []), ("w2", []), ("adv", ["profile=architect", "writes=0", "consult=1"]),
                            ("v", ["role=verifier"])):
            run(d, "member", name, *extra)
        run(d, "ready", "w1", stdin="done\nchecked\nw1 detail")
        run(d, "ready", "w2", stdin="done\nchecked\nw2 detail, @coordinator the port is yours to pick")
        run(d, "ready", "w1", stdin="done\nchecked\nshould the cache stay?")
        run(d, "ready", "adv", stdin="done\nchecked\nadv detail")
        out = run(d, "read", "coordinator")
        assert "w1 detail" not in out and "[full: show --post=1]" in out, out
        # a decision it is asked for, a question, and a consultant's report stay whole
        assert "w2 detail" in out and "cache stay" in out and "adv detail" in out, out
        # a report nobody else reads stays whole
        solo = self.init_run("solo")
        run(solo, "member", "w")
        run(solo, "ready", "w", stdin="done\nchecked\nsolo detail")
        assert "solo detail" in run(solo, "read", "coordinator")

    def test_unstarted_only_once_it_can_act(self):
        d = self.init_run()
        for name, extra in (("a", []), ("b", ["depends=a"]), ("v", ["role=verifier"])):
            run(d, "member", name, *extra)
            run(d, "post", "coordinator", stdin="@%s BRIEF\nOwns: %s" % (name, name))
        run(d, "member", "c", "depends=b", "id=agent-c")

        def unstarted():
            return [i["member"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "unstarted"]

        def blocked():
            return [i["text"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "blocked"]

        assert unstarted() == ["a"] and woken(d) == ["@a"]
        assert blocked() == []  # @c waits for @b, which waits its turn: no fault
        run(d, "member", "a", "id=agent-a")
        run(d, "read", "a")
        run(d, "ready", "a", stdin="done")
        assert unstarted() == ["b"] and "@v" not in woken(d)
        assert blocked() == ["@c waits for @b, which was never started"]
        run(d, "post", "coordinator", "@v please review @a's piece early")
        assert unstarted() == ["b", "v"]

    def test_read_coordinator_attention(self):
        d = self.init_run()
        run(d, "member", "w", "id=agent-w")
        assert run(d, "read", "coordinator") == "no new posts\n"
        run(d, "read", "w", "--attention", ok=False)
        run(d, "post", "w", "@coordinator " + "x" * 200)
        asked = run(d, "post", "w", "@coordinator which file?").split()[1]
        assert "attention" not in run(d, "read", "coordinator", "--attention", "--max-bytes=256")
        out = run(d, "read", "coordinator", "--attention")
        assert "[question] %s @coordinator has not answered @w" % asked in out and "[unread]" not in out, out
        assert out.index("which file?") < out.index("[question]")
        run(d, "post", "w", "@coordinator note")
        assert "attention" not in run(d, "read", "coordinator")

    def test_claims_compare_case_insensitively(self):
        d = self.init_run()
        run(d, "member", "one", "paths=Sources/Feed")
        r = subprocess.run([sys.executable, BOARD, d, "member", "two", "paths=sources/feed/x.swift"], capture_output=True, text=True)
        assert r.returncode != 0 and "both claim" in r.stderr

    def test_prune_dry_run_matches_a_real_prune_for_integration_worktrees(self):
        git = lambda *a: subprocess.run(["git", "-C", self.root, *a], check=True, capture_output=True)
        git("init", "-q")
        git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
            "commit", "-q", "--allow-empty", "-m", "x")
        d = self.init_run()
        run(d, "close")
        wt = os.path.join(d, "integration-abc")
        git("worktree", "add", "-q", "--detach", wt)
        self.init_run("shown")  # the pointer moves on, so the closed run may be archived
        plan = run(self.swarm, "prune", "--days=0", "--dry-run")
        assert "would remove worktree" in plan and "would archive " + os.path.basename(d) in plan, plan
        assert os.path.isdir(wt)
        real = run(self.swarm, "prune", "--days=0")
        assert "archive " + os.path.basename(d) in real and "kept" not in real, real

    def test_prune_removes_only_clean_recorded_baseline_worktrees(self):
        git = lambda *a: subprocess.run(["git", "-C", self.root, *a], check=True, capture_output=True)
        git("init", "-q")
        git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
            "commit", "-q", "--allow-empty", "-m", "x")
        d = self.init_run()
        # A manually created baseline-* worktree with uncommitted edits inside an open run must never be removed.
        manual = os.path.join(d, "baseline-manual-comparison")
        git("worktree", "add", "-q", "--detach", manual)
        with open(os.path.join(manual, "notes.txt"), "w", encoding="utf-8") as f:
            f.write("wip\n")
        # A recorded baseline worktree with an untracked file must be preserved even when status.showUntrackedFiles=no.
        git("config", "status.showUntrackedFiles", "no")
        dirty = os.path.join(d, "baseline-abc123-dirty")
        git("worktree", "add", "-q", "--detach", dirty)
        with open(os.path.join(dirty, "dirty.txt"), "w", encoding="utf-8") as f:
            f.write("edit\n")
        # A clean recorded baseline worktree is removed.
        stale = os.path.join(d, "baseline-abc123-stale")
        git("worktree", "add", "-q", "--detach", stale)
        with open(os.path.join(d, ".baselines.json"), "w", encoding="utf-8") as f:
            json.dump(["baseline-abc123-dirty", "baseline-abc123-stale"], f)
        self.init_run("shown")
        plan = run(self.swarm, "prune", "--days=0", "--dry-run")
        assert "would remove worktree " + stale in plan, plan
        assert "kept " + dirty + ": worktree has uncommitted changes" in plan, plan
        assert manual not in plan, plan
        assert os.path.isdir(stale) and os.path.isdir(manual) and os.path.isdir(dirty)
        real = run(self.swarm, "prune", "--days=0")
        assert "remove worktree " + stale in real and not os.path.exists(stale), real
        assert "kept " + dirty + ": worktree has uncommitted changes" in real and os.path.isdir(dirty), real
        assert os.path.isdir(manual) and os.path.isfile(os.path.join(manual, "notes.txt")), real
        # Clean up extra worktrees before tearDown.
        for wt in (manual, dirty):
            git("worktree", "remove", "--force", wt)

    def test_cli_int_validation_and_trailing_whitespace_truncation(self):
        d = self.init_run()
        run(d, "member", "w", "id=id-w")
        run(d, "post", "coordinator", "@w hello")
        run(d, "read", "w", "--max-bytes=abc", ok=False)
        run(d, "read", "w", "--max-bytes=100", ok=False)
        assert run(d, "claim", "w", "id-w", "abc") == ""
        run(d, "woke", "w", "abc", "tok", ok=False)
        run(d, "tail", "0", ok=False)
        board_path = os.path.join(d, "board.jsonl")
        size_before = os.path.getsize(board_path)
        with open(board_path, "ab") as f:
            f.write(b"   ")
        run(d, "status")
        assert os.path.getsize(board_path) == size_before
        run(d, "post", "coordinator", "@w second")
        assert "#2" in run(d, "show", "--post=2")

    def test_started_isolated_paths_rework_replace_limit_and_init_hardening(self):
        with tempfile.TemporaryDirectory() as t:
            # init rejects leading dot or hyphen
            run(os.path.join(t, ".swarm", ".hidden"), "init", "Bad", ok=False)
            run(os.path.join(t, ".swarm", "-flag"), "init", "Bad", ok=False)
            d = run(os.path.join(t, ".swarm", "hardening"), "init", "Hardening").strip()

            # isolated field on member and started, not inherited on replace
            run(d, "member", "w1", "isolated=1")
            assert saved(d)["members"]["w1"]["isolated"] == "1"
            run(d, "member", "w1", "isolated=2", ok=False)
            run(d, "started", "w1", "id-1", "", ok=True)
            assert "isolated" not in saved(d)["members"]["w1"]  # id change cleared stale isolated
            run(d, "started", "w1", "id-1", "id-1", "isolated=1")
            assert saved(d)["members"]["w1"]["isolated"] == "1"
            run(d, "started", "w1", "id-2", "id-1", "isolated=0")
            assert saved(d)["members"]["w1"]["isolated"] == "0"
            run(d, "started", "w1", "id-2", "id-2", "isolated=2", ok=False)
            run(d, "started", "w1", "id-2", "id-2", "isolated=", ok=False)
            run(d, "member", "w1", "id=id-3")
            assert "isolated" not in saved(d)["members"]["w1"]
            run(d, "member", "w1", "isolated=1")
            run(d, "replace", "w1", "w1b")
            assert "isolated" not in saved(d)["members"]["w1b"]
            # replace refuses already-replaced member
            run(d, "replace", "w1", "w1c", ok=False)

            # group=- clears group in member and replace
            run(d, "member", "w1b", "group=alpha")
            assert saved(d)["members"]["w1b"]["group"] == "alpha"
            run(d, "member", "w1b", "group=-")
            assert not saved(d)["members"]["w1b"].get("group")
            run(d, "member", "w1b", "group=alpha")
            run(d, "replace", "w1b", "w1c", "group=-")
            assert not saved(d)["members"]["w1c"].get("group")

            # paths normalization, rejection of ., \, \r, \0, and claimed_twice ordering
            run(d, "member", "p1", "paths=././a,a/./b")
            assert saved(d)["members"]["p1"]["paths"] == "a,a/b"
            for bad_path in (".", "./", "./.", "a\\b", "a\rb"):
                run(d, "member", "p2", "paths=" + bad_path, ok=False)
            sys.path.insert(0, os.path.dirname(BOARD))
            try:
                import board
                with self.assertRaises(ValueError):
                    board.validate_member("p2", {"role": "worker"}, {"paths": "a\0b"}, {})
            finally:
                sys.path.remove(os.path.dirname(BOARD))
            run(d, "member", "p2", "writes=invalid", "paths=a", ok=False)
            run(d, "member", "p2", "role=verifier", "paths=a")  # verifier does not clash
            att = json.loads(run(d, "attention", "--json"))
            assert "a,a/b" in run(d, "plan")

            # rework ignores killed status of first-line target so body mention is not blamed
            run(d, "member", "des", "profile=designer")
            run(d, "member", "v", "role=verifier")
            for i in range(3):
                run(d, "post", "v", stdin=f"@w1c NOT PASSED: fail {i}\nSee @des")
            run(d, "member", "w1c", "killed=1")
            att2 = json.loads(run(d, "attention", "--json"))
            assert not [i for i in att2["items"] if i["kind"] == "rework" and i["member"] == "des"]

            # limit clearing and budget pause deduplication
            run(d, "resume")
            run(d, "limit", "max_workers=5", "max_members=10", "budget=100")
            run(d, "account", "a" * 64, "coordinator", "200")
            run(d, "limit", "budget=150")
            assert saved(d)["paused"] == "token budget of 150 spent"
            paused_items = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "paused"]
            assert len(paused_items) == 1
            run(d, "limit", "max_workers=", "max_members=", "budget=")
            assert saved(d)["limits"] == {}


    # The findings of the 2026-11-21 review, each test named after its number there (`low` for the unnumbered ones).

    def items(self, d, kind):
        return [item for item in json.loads(run(d, "attention", "--json"))["items"] if item["kind"] == kind]

    def table(self, d, inputs):
        """A candidate under test that holds these members' reports, as verify.py records one."""
        with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
            json.dump({"candidate": "cand", "inputs": inputs}, f)

    def test_f08_rework_counts_confirmed_findings(self):
        d = self.init_run()
        run(d, "member", "inv", "profile=investigator")
        run(d, "member", "v", "role=verifier")
        self.table(d, {"inv": [2, None]})
        for _ in range(2):
            finding = run(d, "ready", "inv", stdin="observed").split()[1][1:]
            run(d, "confirm", "inv", finding)
            run(d, "post", "v", "@inv NOT PASSED: the finding does not hold")
        assert [item["member"] for item in self.items(d, "rework")] == ["inv"]

    def test_an_after_is_added_to_a_member_that_waits_for_one_retired_since(self):
        d = self.init_run()
        for name in ("b", "c"):
            run(d, "member", name)
        run(d, "member", "a", "depends=b")
        run(d, "member", "b", "killed=1")
        run(d, "member", "a", "after=c")  # the wait for @b is inherited, not asked for: only @c is checked
        assert saved(d)["members"]["a"]["depends"].split(",") == ["b", "c"], saved(d)["members"]["a"]
        run(d, "member", "c", "killed=1")
        run(d, "member", "a", "depends=b,c,ghost", ok=False)  # a new name is still checked

    def test_f10_retired_members_and_verifier_dependencies_stay_fixed(self):
        d = self.init_run()
        run(d, "member", "base")
        run(d, "member", "w", "depends=base")
        run(d, "member", "v", "role=verifier")
        run(d, "member", "v", "depends=base", ok=False)
        run(d, "member", "w", "role=verifier", ok=False)  # it would keep its depends=
        run(d, "member", "w", "role=verifier", "depends=")
        run(d, "member", "w", "role=worker", "depends=base")
        run(d, "member", "ghost", "killed=1", ok=False)
        assert "ghost" not in saved(d)["members"]
        run(d, "post", "v", "@base NOT PASSED: no")
        assert not self.items(d, "rework") and len(json.loads(run(d, "attention", "--json"))["members"]) == 3
        run(d, "member", "v", "killed=1")
        run(d, "member", "v", "killed=1")  # said twice changes nothing
        for change in ("role=worker", "owns=x", "id=late", "model=opus", "depends=base"):
            run(d, "member", "v", change, ok=False)
        assert saved(d)["members"]["v"] == {"role": "verifier", "last_read_seq": 0, "killed": "1", "retired_at": 1}
        run(d, "member", "w", "killed=1")
        assert json.loads(run(d, "attention", "--json"))["members"]["w"]["blocked_on"] == []

    def test_f11_rebinding_a_closed_run_keeps_the_pointer(self):
        key = "a" * 64
        old = self.init_run("old")
        run(old, "bind", key)
        run(old, "close")
        one, two = self.init_run("one"), self.init_run("two")
        run(one, "bind", key)
        run(two, "bind", key)
        assert run(self.swarm, "restore", key).strip() == os.path.abspath(two)
        assert run(old, "bind", key).strip() == os.path.abspath(old)
        assert run(self.swarm, "restore", key).strip() == os.path.abspath(two)

    def blocked(self, *command):
        """Start a board command that must wait for a lock the test holds."""
        waiting = subprocess.Popen([sys.executable, BOARD, *command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            waiting.wait(timeout=0.8)
        except subprocess.TimeoutExpired:
            return waiting
        raise AssertionError("%s did not wait: %s" % (command[1], waiting.stdout.read()))

    def test_f12_init_and_prune_wait_for_their_locks(self):
        d = self.init_run()
        with open(os.path.join(self.swarm, ".adopt.lock"), "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            starting = self.blocked(os.path.join(self.swarm, "late"), "init", "Late")
        late, _ = starting.communicate(timeout=20)
        assert starting.returncode == 0 and os.path.isdir(late.strip())
        run(d, "close")
        with open(os.path.join(d, ".lock"), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            pruning = self.blocked(self.swarm, "prune", "--days=0")
            assert os.path.isdir(d)
        done, _ = pruning.communicate(timeout=20)
        assert pruning.returncode == 0 and "archive " + os.path.basename(d) in done and not os.path.exists(d)

    def test_f13_prune_dry_run_matches_prune_and_takes_any_path(self):
        project = os.path.join(self.root, "-proj")
        swarm = os.path.join(project, ".swarm")
        d = run(os.path.join(swarm, "reg"), "init", "Prune").strip()

        def git(*args):
            subprocess.run(["git", "-C", project, "-c", "user.name=T", "-c", "user.email=t@example.invalid",
                            "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)
        git("init", "-q", "-b", "main")
        git("commit", "-q", "--allow-empty", "-m", "init")
        stray, tree = os.path.join(d, "integration-stray"), os.path.join(d, "integration-old")
        os.makedirs(stray)
        git("worktree", "add", "-q", "--detach", tree)
        plan = run(swarm, "prune", "--dry-run")
        assert "would remove worktree " + tree in plan and "would remove worktree " + stray not in plan, plan
        assert "would remove 1 worktree(s)" in plan and os.path.isdir(tree)
        done = subprocess.run([sys.executable, BOARD, "-proj/.swarm", "prune"], cwd=self.root, capture_output=True, text=True)
        assert done.returncode == 0 and "remove 1 worktree(s)" in done.stdout, (done.stdout, done.stderr)
        assert not os.path.exists(tree) and os.path.isdir(stray)
        run(swarm, "prune", "--dry-run", "--dry-run", ok=False)

    def test_f14_code_and_urls_neither_cite_nor_ask_nor_fuse(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "post", "a", "@b which parser do we keep?")
        run(d, "post", "b", "@a the regex one, as `re #1` in the notes says")  # the code cites nothing
        assert self.items(d, "question")
        run(d, "post", "b", "@a re #1: the regex one")
        assert not self.items(d, "question")
        for text in ("@b are you sure??", "@b should we use A? (Option A : yes)"):
            seq = int(re.search(r"#(\d+)", run(d, "post", "a", text)).group(1))
            assert [item["member"] for item in self.items(d, "question")] == ["b"], text
            run(d, "post", "b", "@a re #%d yes" % seq)
        for text in ("@b it is a ?? b", "@b the type is name?: T, read as a?.b", "@b it is c ? a : b"):
            run(d, "post", "a", text)
            assert not self.items(d, "question"), text
        assert "-> @b" in run(d, "post", "a", "see foo`x`@b")  # the span is a gap, not glue that makes an email of it
        assert "nobody" in run(d, "post", "a", "````\n```\n@b\n```\n````")
        assert "nobody" in run(d, "post", "a", "~~~\n@b\n~~~")
        assert "-> @b" in run(d, "post", "a", "```\ncode\n```\n@b after the fence")

    def test_low_a_changed_scope_tells_the_verifier_of_the_candidate_it_voids(self):
        d = self.init_run()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")
        assert "@v" not in run(d, "member", "w", "owns=half")  # no candidate holds its work: nobody tests anything
        run(d, "ready", "w", stdin="done again")
        self.table(d, {"w": [3, None]})
        assert "-> @w @v" in run(d, "member", "w", "owns=the other half")

    def test_low_a_new_finding_tells_who_built_on_the_confirmed_one(self):
        d = self.init_run()
        run(d, "member", "inv", "profile=investigator")
        run(d, "member", "next", "depends=inv")
        run(d, "member", "v", "role=verifier")
        assert run(d, "ready", "inv", stdin="observed").startswith("posted #1 -> @coordinator\n")
        assert run(d, "ready", "inv", stdin="observed again").startswith("posted #2 -> @coordinator\n")  # nothing confirmed yet
        run(d, "confirm", "inv", "2")
        self.table(d, {"inv": [3, None]})
        told = run(d, "ready", "inv", stdin="it is something else").splitlines()[0]
        assert told == "posted #4 -> @coordinator @next @v", told
        assert not json.loads(run(d, "attention", "--json"))["members"]["inv"]["ready"]

    def test_low_a_verifier_is_never_told_to_report_ready(self):
        d = self.init_run()
        run(d, "member", "w")
        run(d, "ready", "w", stdin="done")
        run(d, "member", "w", "role=verifier")
        assert "report again" not in run(d, "show", "--post=2")
        for word in ("READY", "REVISE"):
            refused = subprocess.run([sys.executable, BOARD, d, "post", "w", word + " all checks pass"], capture_output=True, text=True)
            assert refused.returncode != 0 and "board.py DIR" not in refused.stderr and "NOT PASSED" in refused.stderr, refused.stderr
        run(d, "member", "x")
        refused = subprocess.run([sys.executable, BOARD, d, "post", "x", "READY done"], capture_output=True, text=True)
        assert "Use: board.py DIR ready x (report on stdin)" in refused.stderr, refused.stderr

    def test_low_limits_pause_and_a_pending_post_are_validated(self):
        d = self.init_run()
        assert run(d, "limit", "budget=0").startswith("limits: none")  # zero is no budget, and is not kept as one
        assert "budget" not in saved(d)["limits"]
        run(d, "limit", "opus=,", ok=False)
        run(d, "limit", "opus=architect,,architect")
        assert saved(d)["limits"] == {"opus": "architect"}
        run(d, "pause", " ")
        assert saved(d)["paused"] == "awaiting coordinator"
        run(d, "resume")
        state = saved(d)
        state["pending_post"] = {"seq": 1, "agent": 7}
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        run(d, "status", ok=False)
        assert os.path.getsize(os.path.join(d, "board.jsonl")) == 0

    def test_low_prune_removes_bindings_to_runs_that_are_gone(self):
        key, other = "a" * 64, "b" * 64
        gone = self.init_run("gone")
        run(gone, "bind", key)
        run(gone, "close")
        run(self.init_run("kept"), "bind", other)
        bindings = os.path.join(self.swarm, ".bindings")
        assert "would remove 1 stale binding(s)" in run(self.swarm, "prune", "--days=0", "--dry-run")
        assert sorted(os.listdir(bindings)) == [key, other]
        assert "remove 1 stale binding(s)" in run(self.swarm, "prune", "--days=0")
        assert os.listdir(bindings) == [other] and not os.path.exists(gone)

    def test_low_usage_says_when_verifiers_hear_and_what_a_page_cuts(self):
        usage = subprocess.run([sys.executable, BOARD, self.swarm, "nonsense"], capture_output=True, text=True).stderr
        assert "once every worker is ready" in usage and "notify coordinator, verifiers and dependents" not in usage

    # The feature wave after 0.3.44.

    def test_sync_merges_dependencies_and_ready_requires_them(self):
        project = os.path.join(self.root, "proj")
        os.makedirs(project)

        def git(*args):
            return subprocess.run(["git", "-C", project, *args], check=True, capture_output=True, text=True).stdout.strip()

        def board(*args, ok=True, stdin=None):
            r = subprocess.run([sys.executable, BOARD, d, *args], input=stdin, capture_output=True, text=True, cwd=project)
            assert (r.returncode == 0) == ok, (args, r.stdout, r.stderr)
            return r.stdout + r.stderr

        def commit(branch, start, name, text):
            git("switch", "-q", "-C", branch, start)
            with open(os.path.join(project, name), "w") as f:
                f.write(text)
            git("add", name)
            git("commit", "-q", "-m", "change " + name)
            return git("rev-parse", "HEAD")

        git("init", "-q", "-b", "main")
        for key, value in (("user.name", "T"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false")):
            git("config", key, value)
        for name in ("a", "b"):
            with open(os.path.join(project, name), "w") as f:
                f.write("0\n")
        git("add", ".")
        git("commit", "-q", "-m", "base")
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Sync").strip()
        # a member merges in its own worktree: from the project checkout, sync would land on the user's branch
        git("worktree", "add", "-q", "--detach", os.path.join(self.root, "wt"), "main")
        main, project = project, os.path.join(self.root, "wt")
        for who, extra in (("up", []), ("down", ["depends=up"]), ("clash", ["depends=up"]), ("side", [])):
            run(d, "member", who, *extra)
        board("sync", "down", ok=False)  # its dependency has not reported
        up = commit("up", "main", "a", "up\n")
        run(d, "ready", "up", up, stdin="a is up")
        commit("down", "main", "b", "down\n")
        assert "sync down" in board("ready", "down", "HEAD", ok=False, stdin="b is down")
        assert "unmerged: @up " + up in board("sync", "down", "--check-only", ok=False)
        with open(os.path.join(project, "stray"), "w") as f:
            f.write("x")
        assert "uncommitted changes" in board("sync", "down", ok=False)
        os.unlink(os.path.join(project, "stray"))
        refused = subprocess.run([sys.executable, BOARD, d, "sync", "down"], capture_output=True, text=True, cwd=main)
        assert refused.returncode != 0 and "not your worktree" in refused.stderr
        assert "merged @up's commit" in board("sync", "down")
        assert saved(d)["members"]["down"]["synced_deps"] == {"up": up}
        assert "in sync" in board("sync", "down", "--check-only")
        board("ready", "down", "HEAD", stdin="b is down, on top of up")
        # its base is the project checkout's HEAD, not the worktree's: from there the log shows down's work, not up's
        report = json.loads(run(d, "show", "--post=2", "--json"))
        assert report["base"] == git("rev-parse", "main")
        assert git("log", "--first-parent", "--no-merges", "--format=", "--name-only", report["revision"], "--not", report["base"]) == "b"
        # a full commit ID is checked in the project's repository
        assert "sync clash" in board("ready", "clash", commit("clash", "main", "a", "clash\n"), ok=False, stdin="a too")
        assert "@up" in board("sync", "clash", ok=False)  # both change a: the merge is aborted, the checkout left clean
        assert git("status", "--porcelain") == "" and git("rev-parse", "HEAD") == git("rev-parse", "clash")
        # a READY whose commit would conflict with another current READY says so, and attention lists it while both stand
        side = commit("side", "main", "a", "side\n")
        git("switch", "-q", "--detach", "main")
        told = board("ready", "side", side, stdin="a on the side")
        assert told.startswith("posted #") and "conflict: @up's READY #1 and this commit both change a." in told, told
        conflicts = [item for item in self.items(d, "conflict") if item["member"] == "side"]
        assert conflicts and "@up" in conflicts[0]["text"] and conflicts[0]["seq"] == int(told.split()[1][1:])
        run(d, "revise", "side", "rethinking")
        assert not self.items(d, "conflict")
        # with two dependencies, a merge that fails after one that worked leaves that one merged and on record
        apart = commit("apart", "main", "b", "apart\n")
        git("switch", "-q", "--detach", "main")
        run(d, "ready", "side", apart, stdin="b on the side")
        run(d, "member", "both", "depends=side,up")
        commit("both", "main", "a", "both\n")
        assert "@up" in board("sync", "both", ok=False)
        assert saved(d)["members"]["both"]["synced_deps"] == {"side": apart}
        git("merge-base", "--is-ancestor", apart, "HEAD")
        assert git("status", "--porcelain") == ""

    def test_verifiers_and_dependents_aliases(self):
        d = self.init_run()
        for who, extra in (("up", []), ("down", ["depends=up"]), ("other", []), ("v1", ["role=verifier"]),
                           ("v2", ["role=verifier"]), ("old", ["role=verifier"])):
            run(d, "member", who, *extra)
        run(d, "member", "old", "killed=1")
        assert "-> @v1 @v2\n" in run(d, "post", "coordinator", "@verifiers please look")
        assert "-> @down\n" in run(d, "post", "up", "@dependents the API moved")
        assert "-> nobody" in run(d, "post", "coordinator", "@dependents nobody depends on the coordinator")
        assert "@down" in run(d, "ready", "up", stdin="done, @dependents rebase").splitlines()[0]
        for bad in (("member", "verifiers"), ("member", "dependents"), ("member", "other", "group=verifiers"),
                    ("member", "other", "group=dependents"), ("replace", "other", "dependents")):
            run(d, *bad, ok=False)

    def account(self, d, member_id, tokens):
        self.turns = getattr(self, "turns", 0) + 1
        key = hashlib.sha256(("swarm-agent:" + member_id).encode()).hexdigest()
        return json.loads(run(d, "account", "%064x" % self.turns, key, str(tokens)))

    def test_member_budget_pauses_one_member(self):
        d = self.init_run()
        run(d, "member", "w", "id=agent-w", "budget=100")
        run(d, "member", "x", "id=agent-x")
        run(d, "member", "coordinator", "budget=5", ok=False)
        run(d, "member", "x", "budget=lots", ok=False)
        assert "member_paused" not in self.account(d, "agent-w", 60)
        assert self.account(d, "agent-w", 60)["member_paused"] == "w"
        assert saved(d)["members"]["w"]["paused"] == "token budget of 100 spent"
        assert "member_paused" not in self.account(d, "agent-w", 1)  # already paused
        run(d, "post", "coordinator", "@w @x news")
        assert woken(d) == ["@x"]
        run(d, "member", "after", "depends=w")
        assert "@after waits for @w, which is paused: token budget of 100 spent" in [item["text"] for item in self.items(d, "blocked")]
        run(d, "member", "after", "depends=")
        report = json.loads(run(d, "attention", "--json"))
        assert report["members"]["w"]["paused"] and not report["members"]["x"]["paused"]
        assert [item["member"] for item in report["items"] if item["kind"] == "member_paused"] == ["w"]
        refused = subprocess.run([sys.executable, BOARD, d, "resume", "w"], capture_output=True, text=True)
        assert refused.returncode != 0 and "121 of its 100 tokens" in refused.stderr, refused.stderr
        run(d, "resume", "x", ok=False)  # not paused
        run(d, "member", "w", "budget=-")
        assert "budget" not in saved(d)["members"]["w"]
        assert "-> @w" in run(d, "resume", "w")
        assert "paused" not in saved(d)["members"]["w"] and "@w" in woken(d)
        # the run's member_budget applies to a member without its own, and retiring a member drops its pause
        run(d, "limit", "member_budget=50")
        assert self.account(d, "agent-x", 50)["member_paused"] == "x"
        run(d, "member", "x", "killed=1")
        assert "paused" not in saved(d)["members"]["x"]
        run(d, "member", "y", "id=agent-y")
        assert self.account(d, "agent-y", 50)["member_paused"] == "y"
        run(d, "replace", "y", "y2")
        assert "paused" not in saved(d)["members"]["y"] and "paused" not in saved(d)["members"]["y2"]
        run(d, "limit", "member_budget=0")
        assert "member_budget" not in saved(d).get("limits", {})

    def test_a_budget_lowered_under_the_spend_pauses_at_once(self):
        d = self.init_run()
        run(d, "member", "a", "id=agent-a")
        run(d, "member", "b", "id=agent-b")
        self.account(d, "agent-a", 5_000)
        self.account(d, "agent-b", 5_000)
        assert "paused: @a" in run(d, "member", "a", "budget=4000")
        assert saved(d)["members"]["a"].get("paused") and not saved(d)["members"]["b"].get("paused")
        assert "paused: @b" in run(d, "limit", "member_budget=5000")
        assert saved(d)["members"]["b"]["paused"] == "token budget of 5000 spent"

    def test_spend_of_a_pair_and_loops(self):
        d = self.init_run()
        run(d, "member", "a", "id=agent-a")
        run(d, "member", "b", "id=agent-b")
        self.account(d, "agent-a", 140_000)
        self.account(d, "agent-b", 60_000)
        assert not self.items(d, "spend")  # 70% of the pair
        self.account(d, "agent-a", 50_000)
        assert [item["member"] for item in self.items(d, "spend")] == ["a"]  # 76%
        assert not self.items(d, "loop")  # 190,000 tokens are a dozen honest steps: each one re-reads the conversation
        self.account(d, "agent-a", 560_000)
        assert not self.items(d, "loop")  # 750,000 is the boundary (not > 750,000)
        self.account(d, "agent-a", 1)
        assert [item["member"] for item in self.items(d, "loop")] == ["a"]  # 750,001 tokens without a post or a read
        run(d, "post", "a", "@b still on it")
        assert not self.items(d, "loop")
        for _ in range(148):  # its 149th step since it began
            self.account(d, "agent-b", 10)
        assert not self.items(d, "loop")
        self.account(d, "agent-b", 10)
        assert [item["member"] for item in self.items(d, "loop")] == ["b"]
        run(d, "read", "b")
        assert not self.items(d, "loop")
        # Verifiers are included in loop detection too.
        run(d, "member", "v", "role=verifier", "id=agent-v")
        self.account(d, "agent-v", 760_000)
        assert [item["member"] for item in self.items(d, "loop")] == ["v"]
        run(d, "post", "v", "@coordinator checking")
        assert not self.items(d, "loop")

    def test_the_budget_is_allocated_from_the_planned_team_until_the_first_member_starts(self):
        d = self.init_run()
        def saved(run_dir=None):
            with open(os.path.join(run_dir or d, "members.json"), encoding="utf-8") as f:
                return json.load(f)
        assert saved()["limits"] == {"budget": "3000000"}  # the bound before anyone is registered
        run(d, "member", "scout", "profile=investigator", "writes=0", "owns=why the retry fails", "size=s")
        run(d, "member", "fixer", "owns=src", "size=l")
        run(d, "member", "checker", "role=verifier")
        # 500k*0.5 + 700k*2 + 600k = 2.25M; coordinator 300k + 3*40k; reserve 20% of the shares
        state = saved()
        assert [state["members"][n]["alloc"] for n in ("scout", "fixer", "checker")] == [250000, 1400000, 600000], state
        assert state["limits"]["budget"] == str(2250000 + 420000 + 450000), state
        plan = run(d, "plan")
        assert "budget: 3,120,000 tokens, allocated from this team: @scout 250,000, @fixer 1,400,000, @checker 600,000, coordinator 420,000, reserve 450,000" in plan, plan
        run(d, "member", "scout", "effort=high")  # effort counts, and a size that is none is refused
        assert saved()["members"]["scout"]["alloc"] == 375000
        run(d, "member", "scout", "size=huge", ok=False)
        # the first start fixes it: a member added afterwards raises nothing, but gets a share to be stopped at
        run(d, "member", "scout", "id=scout-address")
        fixed = saved()["limits"]["budget"]
        run(d, "member", "extra", "owns=docs", "size=l")
        state = saved()
        assert state["limits"]["budget"] == fixed and state["members"]["extra"]["alloc"] == 1400000, state
        assert state["members"]["scout"]["alloc"] == 375000, state  # a share already given is kept
        assert "over budget: this team is estimated at 4,990,000 tokens, the budget is 3,270,000." in run(d, "plan")
        assert "fixed since the first member started" in run(d, "plan")
        # a replacement takes the piece and its share; a member is stopped alone at 1.5 times its share
        run(d, "replace", "scout", "scout-2")
        assert saved()["members"]["scout-2"]["alloc"] == 375000 and saved()["limits"]["budget"] == fixed
        run(d, "member", "scout-2", "id=scout-2-address")
        key = hashlib.sha256(b"swarm-agent:scout-2-address").hexdigest()
        assert "member_paused" not in json.loads(run(d, "account", "1" * 64, key, "562499"))
        assert json.loads(run(d, "account", "2" * 64, key, "1"))["member_paused"] == "scout-2"
        # a team estimated past what the board allocates is said so: the cap supplies no tokens
        big = self.init_run("big")
        for name in ("a", "b", "c", "d"):
            run(big, "member", name, "owns=src/" + name, "size=l", "effort=high")
        run(big, "member", "v", "role=verifier")
        plan = run(big, "plan")
        assert saved(big)["limits"]["budget"] == "8000000", saved(big)
        assert "over budget: this team is estimated at 11,300,000 tokens, the budget is 8,000,000." in plan, plan
        # the user's word ends the allocation, before a start too
        other = self.init_run("named")
        run(other, "limit", "budget=900000")
        run(other, "member", "w", "owns=src")
        named = saved(other)
        assert named["limits"]["budget"] == "900000" and "alloc" not in named["members"]["w"], named
        # their figure stands, and a team estimated over it is said so with the plan, costliest piece first
        plan = run(other, "plan")
        assert "allocated from this team" not in plan
        assert "over budget: this team is estimated at 1,180,000 tokens, the budget is 900,000." in plan and "Costliest: @w 700,000" in plan, plan
        run(other, "member", "w", "size=s")
        assert "over budget" not in run(other, "plan")

    def test_a_read_only_member_past_the_context_ceiling_is_woken_once_more_only_to_report(self):
        d = self.init_run()

        def saved():
            with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
                return json.load(f)
        run(d, "member", "scout", "profile=investigator", "writes=0", "owns=why the retry fails")
        run(d, "member", "fixer", "owns=src")
        run(d, "post", "coordinator", "@scout BRIEF\nOwns: the retry bug")
        run(d, "post", "coordinator", "@fixer BRIEF\nOwns: src")
        run(d, "member", "scout", "id=scout-address")
        run(d, "member", "fixer", "id=fixer-address")
        scout, fixer = (hashlib.sha256(("swarm-agent:%s-address" % n).encode()).hexdigest() for n in ("scout", "fixer"))
        # a step says what context it read, a turn's end does not: only the first is kept
        run(d, "account", "1" * 64, scout, "30", "start:2,1000,291000,50,292002")
        run(d, "account", "2" * 64, scout, "5", "start:0,0,900000,5")
        run(d, "account", "3" * 64, fixer, "30", "start:2,1000,291000,50,292002")
        assert saved()["members"]["scout"]["held"] == 292002 and saved()["members"]["fixer"]["held"] == 292002
        run(d, "account", "4" * 64, scout, "1", "start:1,2,3,4,x", ok=False)
        # with no report on the board it is still woken: its tools are stopped, but its findings are not lost
        run(d, "post", "coordinator", "@scout @fixer where do you stand?")
        assert "@scout" in run(d, "wake") and "@fixer" in run(d, "wake")
        assert "heavy" not in run(d, "attention")
        # once its report is there, no path wakes it again; a writer of the same size is still woken
        run(d, "ready", "scout", stdin="the retry loop never resets its counter (src/net/retry.ts:40)")
        run(d, "post", "coordinator", "@scout @fixer one more thing")
        wake = run(d, "wake")
        assert "@scout" not in wake and "@fixer" in wake, wake
        assert not run(d, "claim", "scout", "scout-address", "5").strip()
        assert re.fullmatch(r"[a-f0-9]{32}", run(d, "claim", "fixer", "fixer-address", "5").strip())
        report = json.loads(run(d, "attention", "--json"))
        assert [(i["member"], i["seq"]) for i in report["items"] if i["kind"] == "heavy"] == [("scout", 4)], report["items"]
        assert report["members"]["scout"]["heavy"] and not report["members"]["fixer"]["heavy"]
        assert "replace scout scout-2" in run(d, "attention")
        # its replacement starts light, and is woken
        run(d, "replace", "scout", "scout-2")
        assert "held" not in saved()["members"]["scout-2"] and "@scout-2" in run(d, "wake")

    def test_a_final_report_the_hooks_put_on_the_board_counts_as_the_members_report(self):
        d = self.init_run()
        run(d, "member", "scout", "profile=investigator", "writes=0", "owns=q", "id=scout-address")
        key = hashlib.sha256(b"swarm-agent:scout-address").hexdigest()
        run(d, "account", "1" * 64, key, "30", "start:2,1000,291000,50,292002")
        run(d, "post", "coordinator", "@scout BRIEF\nOwns: q")
        run(d, "post", "scout", "@coordinator HAND-BACK: @scout's turn ended with this report in no board post.\nfound X")
        run(d, "post", "coordinator", "@scout thanks, one more")
        assert "@scout" not in run(d, "wake") and "heavy" in run(d, "attention")

    def test_effort_follows_the_size_of_the_piece_and_a_start_records_what_ran(self):
        d = self.init_run()

        def saved():
            with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
                return json.load(f)["members"]
        run(d, "member", "small", "owns=a", "size=s")
        run(d, "member", "big", "owns=b", "size=l")
        run(d, "member", "probe", "profile=investigator", "writes=0", "owns=q", "size=l")
        run(d, "member", "named", "owns=c", "size=l", "effort=low")
        plan = run(d, "plan")
        for name, effort in (("small", "low"), ("big", "high"), ("probe", "high"), ("named", "low")):
            assert re.search(r"@%s\s+\S+\s+\S+\s+%s\s" % (name, effort), plan), (name, plan)
        # size is counted once: only an effort named for the member moves its share again
        assert [saved()[n]["alloc"] for n in ("small", "big", "probe", "named")] == [350000, 1400000, 1000000, 980000]
        assert "effort" not in saved()["big"]
        # the start records the model and effort it ran on, so a default changed later rewrites no history
        run(d, "member", "big", "id=big-address")
        assert (saved()["big"]["effort"], saved()["big"]["model"]) == ("high", "sonnet")
        # the recorded effort is the size again, not a second charge; one named afterwards is
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        assert saved()["big"]["alloc"] == 1400000 and board.allocation({"members": saved()})[0]["big"] == 1400000
        named = saved()
        named["big"].pop("sized")
        assert board.allocation({"members": named})[0]["big"] == 2100000
        run(d, "member", "big", "size=s")
        assert saved()["big"]["effort"] == "high"

    def test_export_writes_a_report_and_changes_nothing(self):
        d = self.init_run()
        run(d, "member", "w", "owns=a|b")
        run(d, "member", "v", "role=verifier")
        run(d, "post", "coordinator", "@w BRIEF\nOwns: a")
        run(d, "ready", "w", stdin="done")
        # Seen live: members registered and never started read as unfinished work with a plain "no".
        run(d, "member", "idle", "owns=later")
        run(d, "member", "gone", "owns=dropped")
        run(d, "member", "gone", "killed=1")
        run(d, "member", "late", "owns=begun", "id=late-1")
        with open(os.path.join(d, "members.json"), "rb") as f:
            before = f.read()
        path = run(d, "export").strip()
        assert path == os.path.join(os.path.abspath(d), "summary.md")
        with open(path, encoding="utf-8") as f:
            report = f.read()
        for part in ("# Regression", "Status: open. 2 posts.", "| @w | worker | sonnet | medium | a\\|b | yes | 0 |",
                     "| later | not started | 0 |", "| @gone (retired) |", "| dropped | not started | 0 |", "| begun | no | 0 |",
                     "No candidate was prepared.", "## Transcript", "> @w BRIEF", "> Owns: a", "-> @w"):
            assert part in report, (part, report)
        out = os.path.join(self.root, "elsewhere.md")
        assert run(d, "export", "--out=" + out).strip() == out and os.path.isfile(out)
        run(d, "export", "--bogus", ok=False)
        with open(os.path.join(d, "members.json"), "rb") as f:
            assert f.read() == before

    def test_a_partial_pass_clears_rework_only_for_its_workers(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        members = {"coordinator": {"role": "coordinator"}, "a": {"role": "worker"}, "b": {"role": "worker"}, "v": {"role": "verifier"}}
        posts = [{"seq": 1, "agent": "v", "text": "@a @b NOT PASSED: both", "to": ["a", "b"], "candidate": "c1"},
                 {"seq": 2, "agent": "v", "text": "@coordinator VERIFIED c2 x", "to": ["coordinator"], "partial": True, "members": ["a"]}]
        assert board.rework({"members": members}, posts) == {"b": [1]}
        posts[1].pop("partial")
        assert board.rework({"members": members}, posts) == {}

    # The audit of 0.3.46.

    def test_question_check_is_linear_in_a_run_of_spaces(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        start = time.monotonic()
        assert board.QUESTION.search("a ?" + " " * 3000 + "b")  # seconds under a pattern that backtracks
        assert board.asks("takes Int?" + " " * 3000 + "b")  # so is the optional type's lookahead
        # and the clause each optional type is read in: one long clause, many types, a long lead of blanks and mentions
        assert not board.asks(" " * 3000 + "@a " * 3000 + "it takes Int? and " * 30000 + "@" + "b" * 3000 + "x")
        assert time.monotonic() - start < 1

    # The review of the uncommitted change on 0.3.50.

    def test_an_optional_type_in_a_question_still_asks(self):
        d = self.init_run()
        run(d, "member", "w", "id=agent-w")
        run(d, "post", "w", "@coordinator May I edit ListView? and its tests too.")
        run(d, "post", "w", "@coordinator May I edit ListView? is it outside my paths")
        run(d, "post", "w", "@coordinator Fixed. It returns Date? in both cases")
        # a dot inside a path ends no clause
        run(d, "post", "w", "@coordinator Can I make src/config.ts return Config? or nil on lookup failure")
        run(d, "post", "w", "@coordinator The return value is Config? or nil")
        qs = [i["seq"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        assert qs == [1, 2, 4], qs

    def test_a_brief_orders_no_command_from_a_member_without_a_shell(self):
        d = self.init_run()
        run(d, "member", "probe", "profile=investigator", "writes=0")
        run(d, "member", "w")
        for brief in ("@probe BRIEF\nRead `git diff` for your files first.", "@probe @w BRIEF\nSeams: start with `git diff hooks/a.ts`."):
            refused = subprocess.run([sys.executable, BOARD, d, "post", "coordinator"], input=brief, capture_output=True, text=True).stderr
            assert "@probe has no shell" in refused and "git diff" in refused and "Nothing was posted" in refused, refused
        for brief in ("@probe BRIEF\nRun ls -la first.", "@probe BRIEF\nExecute `wc -c` on each file."):  # any command after "run"
            refused = subprocess.run([sys.executable, BOARD, d, "post", "coordinator"], input=brief, capture_output=True, text=True)
            assert refused.returncode != 0 and "@probe has no shell" in refused.stderr, (brief, refused.stderr)
        run(d, "post", "coordinator", stdin="@w BRIEF\nRun `git diff` first.")  # a worker has a shell
        run(d, "post", "coordinator", stdin="@w BRIEF\nRun `git diff` first. Ask @probe about the parser.")  # named, not assigned
        run(d, "post", "coordinator", stdin="@probe BRIEF\nRead `src/a.ts`, use `parseDate` as the entry, and run through its callers.")
        run(d, "post", "coordinator", stdin="@probe BRIEF\nDo not run `git commit`. The diff is in /tmp/d.patch: Read it.")
        run(d, "post", "coordinator", stdin="@probe the bug shows when you run `git status`")  # no brief, no order

    def test_a_question_quoted_whole_asks_nothing(self):
        d = self.init_run()
        run(d, "member", "w")
        run(d, "post", "w", stdin='@coordinator interim. Scenario: the verifier posts "@w does parse() handle CRLF?" and gets no answer.')
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]
        run(d, "post", "w", stdin='@coordinator Should I use "strict"? The alternative is "loose".')  # the mark stands outside both spans
        assert len([i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]) == 1
        run(d, "post", "w", stdin='@coordinator should I use "strict" or "loose"?')
        assert [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "question"]

    def test_a_verifier_with_reviews_hears_each_named_ready_as_it_arrives(self):
        def unstarted(d):
            return [i["member"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "unstarted"]

        def posts(d):
            with open(os.path.join(d, "board.jsonl")) as f:
                return [json.loads(line) for line in f]

        d = self.init_run()
        for name in ("a", "b", "c"):
            run(d, "member", name)
        run(d, "member", "a", "reviews=b", ok=False)  # a verifier's option
        run(d, "member", "v", "role=verifier", "reviews=a,ghost", ok=False)
        run(d, "member", "v", "role=verifier", "reviews=@A")
        run(d, "post", "coordinator", stdin="@a @b @c @v BRIEF\nShared: the parser")
        run(d, "ready", "b", stdin="done")
        assert "v" not in posts(d)[-1]["to"] and "v" not in unstarted(d)  # @b is not one it reviews early
        run(d, "ready", "a", stdin="done")
        assert "v" in posts(d)[-1]["to"] and "v" in unstarted(d)  # @a is: the verifier is to be started now
        run(d, "member", "v", "reviews=all")
        run(d, "revise", "a", "one more case")
        assert "v" in unstarted(d)  # @b's READY still stands, and all of them are its to review
        run(d, "member", "v", "reviews=")
        assert "reviews" not in saved(d)["members"]["v"] and "v" not in unstarted(d)

    def test_a_read_only_report_is_kept_as_a_file_for_briefs_to_name(self):
        d = self.init_run()
        run(d, "member", "scout", "profile=explorer")
        run(d, "member", "w")
        said = run(d, "ready", "scout", stdin="MAP\nparser: src/parse.py:10 entry, tests in tests/test_parse.py")
        kept = os.path.join(d, "context", "scout.md")
        with open(kept) as f:
            assert kept in said and f.read() == "MAP\nparser: src/parse.py:10 entry, tests in tests/test_parse.py\n"
        assert "context:" not in run(d, "ready", "w", stdin="done")  # a writer's report is no background

    def test_only_a_request_wakes_a_verifier_early(self):
        def unstarted(d):
            return [i["member"] for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "unstarted"]

        for request in ("@verifiers please test this partial candidate", "@v please test this partial candidate"):
            d = self.init_run()
            for name, extra in (("a", ["group=pool"]), ("b", ["group=pool"]), ("v", ["role=verifier", "group=pool"])):
                run(d, "member", name, *extra)
            run(d, "post", "coordinator", stdin="@a @b @v BRIEF\nShared: the parser")
            run(d, "post", "coordinator", stdin="@v BRIEF\nTest the parser")
            assert "v" not in unstarted(d)  # a second brief is no request
            run(d, "member", "a", "id=agent-a")
            run(d, "read", "a")
            run(d, "ready", "a", stdin="done, @v can look now")
            assert "v" not in unstarted(d)  # neither is a READY, whatever it names
            run(d, "ready", "b", stdin="done")  # the last READY reaches @v on its own
            run(d, "revise", "a", "one more case")
            assert "v" not in unstarted(d)  # and stops counting once a worker is unready again
            run(d, "post", "coordinator", "@all the API moved to v2")
            run(d, "post", "coordinator", "@pool the API moved to v2")
            assert "v" not in unstarted(d)  # a broadcast is news, not a request
            run(d, "post", "a", request.replace("please test", "you could already look at"))
            assert "v" not in unstarted(d)  # a member's mention is an interim note: only the coordinator asks for a review
            run(d, "post", "coordinator", request)
            assert "v" in unstarted(d), request

    def test_a_late_reader_is_shown_only_reports_that_count(self):
        d = self.init_run()
        for name, extra in (("a", []), ("b", []), ("c", []), ("v", ["role=verifier"])):
            run(d, "member", name, *extra)
        run(d, "ready", "a", stdin="a is done")
        run(d, "ready", "b", stdin="b is done")
        run(d, "ready", "c", stdin="c is done")
        run(d, "post", "v", "@a NOT PASSED: the test fails")
        run(d, "member", "b", "killed=1")
        run(d, "member", "v2", "role=verifier")  # registered after them: each is replayed if it counts
        out = run(d, "read", "v2")
        assert "c is done" in out and "a is done" not in out and "b is done" not in out, out

    def test_a_new_agent_has_read_nothing(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "w", "depends=a", "id=agent-1")
        run(d, "ready", "a", stdin="a is done")
        run(d, "read", "w")
        assert saved(d)["members"]["w"]["delivered"] == [1]
        run(d, "started", "w", "agent-1", "agent-1")  # the same agent again
        assert saved(d)["members"]["w"]["delivered"] == [1]
        run(d, "started", "w", "agent-2", "agent-1")
        assert "delivered" not in saved(d)["members"]["w"]
        assert "a is done" in run(d, "read", "w")
        run(d, "member", "w", "id=agent-3")
        assert "delivered" not in saved(d)["members"]["w"]

    def test_a_cut_report_is_not_delivered_and_not_cut_again(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "w", "depends=a")
        run(d, "ready", "a", stdin="a is done\n" + "detail " * 100)
        out = run(d, "read", "w", "--max-bytes=256")
        assert "[cut to fit the page. The whole post: show --post=1]" in out, out
        w = saved(d)["members"]["w"]
        assert "delivered" not in w and w["clipped"] == [1], w
        assert "a is done" not in run(d, "read", "w", "--max-bytes=256")

    def test_replace_classifies_briefs_by_who_they_reached(self):
        d = self.init_run()
        run(d, "member", "parser", "group=money")
        run(d, "member", "currency", "group=money")
        run(d, "member", "solo", "group=crew")
        run(d, "post", "coordinator", stdin="@money BRIEF\nShared: the money type")
        run(d, "post", "coordinator", stdin="@parser BRIEF\nOwns: the parser")
        run(d, "post", "coordinator", stdin="@crew BRIEF\nOwns: the crew work")
        run(d, "member", "parser", "group=-")  # no longer in the group the shared brief reached
        run(d, "member", "currency", "group=crew")  # in a group whose brief reached only @solo
        run(d, "replace", "parser", "parser-2")
        brief = run(d, "show", "parser-2")
        assert "Shared brief #1: Shared: the money type" in brief and "Owns: the parser" in brief, brief
        run(d, "replace", "solo", "solo-2")
        brief = run(d, "show", "solo-2")
        assert "Shared brief" not in brief and "Owns: the crew work" in brief, brief

    def test_replace_reads_whom_a_brief_assigned_when_it_was_posted(self):
        d = self.init_run()
        run(d, "member", "parser", "group=money")
        run(d, "member", "currency", "group=money")
        run(d, "member", "lexer")
        run(d, "post", "coordinator", stdin="@money BRIEF\nShared: the money type, which @parser leads")
        run(d, "post", "coordinator", stdin="@lexer BRIEF\nOwns: the lexer; ask @parser about tokens")
        with open(os.path.join(d, "board.jsonl"), encoding="utf-8") as f:
            posts = [json.loads(line) for line in f]
        assert [p.get("addressed") for p in posts] == [
            ["parser", "currency"], ["lexer"]]
        run(d, "member", "parser", "group=-")
        run(d, "replace", "parser", "parser-2")
        brief = run(d, "show", "parser-2")
        # the shared brief reached it as an addressee; the lexer's only names it, which assigns nothing
        assert "Shared brief #1: Shared: the money type" in brief and "Owns: the lexer" not in brief, brief
        run(d, "replace", "lexer", "lexer-2")
        assert "Owns: the lexer" in run(d, "show", "lexer-2")

    def test_replace_never_takes_a_body_mention_for_a_brief(self):
        d = self.init_run()
        run(d, "member", "parser")
        run(d, "member", "lexer")
        run(d, "post", "coordinator", stdin="@lexer BRIEF\nOwns: the lexer; ask @parser about tokens")
        run(d, "replace", "parser", "parser-2")
        brief = run(d, "show", "parser-2")
        assert "(@parser had no brief on the board)" in brief and "Owns: the lexer" not in brief, brief

    def test_agent_run_finds_a_killed_run_for_a_retired_member(self):
        key = "d" * 64
        # a native teammate's address comes back in each run of the conversation
        old = self.init_run("job")
        run(old, "bind", key)
        run(old, "member", "t", "id=teammate-1")
        run(old, "close")
        d = self.init_run("job")
        run(d, "bind", key)
        run(d, "member", "w", "id=agent-w")
        run(d, "member", "t", "id=teammate-1")
        run(d, "kill")
        assert saved(d)["closed"] and saved(d)["members"]["w"]["killed"] == "1"
        for agent in ("agent-w", "teammate-1"):  # the latest run that had it, though none is open
            assert run(self.swarm, "agent-run", key, agent).strip() == os.path.abspath(d)
        assert not run(self.swarm, "restore", key).strip()  # nothing is resumed on a killed run
        third = self.init_run("job")
        run(third, "bind", key)
        run(third, "member", "t", "id=teammate-1")
        run(third, "member", "u", "id=teammate-2")
        assert run(self.swarm, "agent-run", key, "teammate-1").strip() == os.path.abspath(third)  # an open run wins

    def test_a_revise_tells_the_verifier_of_a_partial_candidate_built_on_it(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b", "depends=a")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "a", stdin="done")
        run(d, "ready", "b", stdin="done on a")
        self.table(d, {"b": [2, None]})  # `--members b`: a's work is in it through b
        assert "@v" in run(d, "revise", "a", "a flaw")

    def test_a_refused_member_change_pauses_nobody(self):
        d = self.init_run()
        run(d, "member", "a", "id=agent-a")
        self.account(d, "agent-a", 5_000)
        assert "paused" not in run(d, "member", "a", "budget=4000", "depends=ghost", ok=False)
        assert not saved(d)["members"]["a"].get("paused")

    def test_a_rejection_outside_a_partial_candidate_keeps_its_pass(self):
        d = self.init_run()
        for who, extra in (("a", []), ("b", []), ("v", ["role=verifier"])):
            run(d, "member", who, *extra)
        path = os.path.join(d, "verification.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"candidate": "cand", "inputs": {"b": [1, None]}, "partial": True, "members": ["b"], "verified_by": "v"}, f)
        run(d, "post", "v", "@a NOT PASSED: the parser drops zeros")
        with open(path, encoding="utf-8") as f:
            assert json.load(f)["verified_by"] == "v"
        run(d, "post", "v", "@b NOT PASSED: the printer drops them too")
        with open(path, encoding="utf-8") as f:
            assert "verified_by" not in json.load(f)

    def git_project(self):
        """A project in its own repository, and a helper that commits one file on a branch and returns the commit."""
        project = os.path.join(self.root, "proj")
        os.makedirs(project)

        def git(*args):
            return subprocess.run(["git", "-C", project, *args], check=True, capture_output=True, text=True).stdout.strip()

        def commit(branch, start, name, text):
            git("switch", "-q", "-C", branch, start)
            with open(os.path.join(project, name), "w") as f:
                f.write(text)
            git("add", name)
            git("commit", "-q", "-m", "change " + name)
            return git("rev-parse", "HEAD")

        git("init", "-q", "-b", "main")
        for key, value in (("user.name", "T"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false")):
            git("config", key, value)
        with open(os.path.join(project, "a"), "w") as f:
            f.write("0\n")
        git("add", ".")
        git("commit", "-q", "-m", "base")
        return project, commit

    def test_ready_compares_only_with_reports_that_stay_current(self):
        project, commit = self.git_project()
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Merge").strip()
        run(d, "member", "up")
        run(d, "member", "down", "depends=up")
        run(d, "ready", "up", commit("up", "main", "a", "up\n"), stdin="a is up")
        run(d, "ready", "down", commit("down", "up", "b", "down\n"), stdin="b is down, on up")
        # down's READY falls with this one and down syncs it anyway: its old commit is no conflict
        told = run(d, "ready", "up", commit("up2", "main", "a", "up again\n"), stdin="a rewritten")
        assert "conflict" not in told and not self.items(d, "conflict"), told

    def test_ready_needs_a_commit_the_project_has_and_sync_a_writer(self):
        project, commit = self.git_project()
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Commits").strip()
        run(d, "member", "w")
        run(d, "member", "scout", "writes=0")
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w", "f" * 40], input="done", capture_output=True, text=True)
        assert refused.returncode != 0 and "no commit in the project's repository" in refused.stderr, refused.stderr
        run(d, "ready", "w", commit("w", "main", "a", "w\n"), stdin="done")
        run(d, "member", "art", "profile=designer")
        run(d, "ready", "art", commit("art", "main", "icon", "drawn\n"), stdin="icons drawn")  # a designer's report may carry one
        refused = subprocess.run([sys.executable, BOARD, d, "sync", "scout"], capture_output=True, text=True, cwd=project)
        assert refused.returncode != 0 and "read-only" in refused.stderr, refused.stderr

    def test_a_lower_budget_restates_a_members_pause(self):
        d = self.init_run()
        run(d, "member", "a", "id=agent-a")
        run(d, "member", "b", "id=agent-b")
        self.account(d, "agent-a", 5_000)
        self.account(d, "agent-b", 5_000)
        run(d, "member", "a", "budget=4000")
        assert "paused" not in run(d, "member", "a", "budget=3000")  # already paused: said once
        assert saved(d)["members"]["a"]["paused"] == "token budget of 3000 spent"
        run(d, "limit", "member_budget=4500")
        run(d, "limit", "member_budget=4000")
        assert saved(d)["members"]["b"]["paused"] == "token budget of 4000 spent"

    def test_a_citation_after_re_colon_answers_only_that_question(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "post", "a", "@b which parser?")
        run(d, "post", "a", "@b which printer?")
        run(d, "post", "b", "@a re: #1 the regex one. The build number was #2.")
        assert [item["seq"] for item in self.items(d, "question")] == [2]

    def test_a_ready_answers_the_question_it_explicitly_cites(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "post", "a", "@b which parser?")
        run(d, "post", "a", "@b which printer?")
        run(d, "ready", "b", stdin="re #1 the regex parser. This also relates to #2.")
        assert [item["seq"] for item in self.items(d, "question")] == [2]

    def test_history_pages_are_exclusive_and_ordered(self):
        d = self.init_run()
        for n in range(1, 15):
            run(d, "post", "coordinator", f"Post {n}")
        page = run(d, "show", "--before=15", "--json").splitlines()
        assert [json.loads(line)["seq"] for line in page] == list(range(3, 15))
        earlier = run(d, "show", "--before=3", "--json").splitlines()
        assert [json.loads(line)["seq"] for line in earlier] == [1, 2]

    def test_retiring_the_last_unready_worker_notifies_the_verifier(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "b")
        run(d, "member", "v", "role=verifier", "id=verifier-agent")
        run(d, "ready", "a", stdin="my part is ready")
        run(d, "read", "v")
        run(d, "member", "b", "killed=1")
        assert "v " in run(d, "wake")
        assert "was retired" in run(d, "read", "v")

    def test_retiring_every_worker_does_not_send_the_verifier_an_empty_candidate(self):
        d = self.init_run()
        run(d, "member", "a")
        run(d, "member", "v", "role=verifier", "id=verifier-agent")
        run(d, "member", "a", "killed=1")
        assert "v " not in run(d, "wake")
        assert "was retired" not in run(d, "read", "v")

    def test_a_long_unbroken_token_is_read_for_questions_in_linear_time(self):
        # Quadratic before: 12,000 characters took 0.1 s, so this took most of a minute.
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        started = time.monotonic()
        assert board.QUOTED.sub(" ", "x" * 300_000 + " is that so?").endswith(" is that so?")
        assert board.asks("x" * 300_000 + " is that so?")
        assert time.monotonic() - started < 2

    def test_parity_vectors_match_the_board(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "parity.json"), encoding="utf-8") as f:
            vectors = json.load(f)
        # A kind of vector added to the file and checked here by nobody would let drift through unseen.
        assert set(vectors) == {"targets", "quoted", "question", "kind", "actions", "defaults", "effort"}, sorted(vectors)
        for kind, size, expect in vectors["effort"]:
            assert board.sized_effort(kind, size or None) == expect, (kind, size)
        # The pane's list of board commands (hooks/hive.ts) and its starting model and effort per type (hooks/models.ts).
        assert vectors["actions"] == sorted(board.ARG_COUNTS)
        assert vectors["defaults"] == {kind: list(pair) for kind, pair in board.DEFAULTS.items()}
        for case in vectors["targets"]:
            assert board.targets(case["text"], case["members"], sender=case["sender"]) == case["expect"], case
        for case in vectors["quoted"]:
            assert board.QUOTED.sub(" ", case["text"]) == case["expect"], case
        for case in vectors["question"]:
            assert board.asks(case["text"]) == case["expect"], case
        for case in vectors["kind"]:
            word = board.REPORT_WORD.match(case["text"])
            assert (word[1] if word else "") == case["expect"], case

    # The audit of 0.3.47.

    def test_resume_wakes_a_verifier_stopped_in_a_review(self):
        d = self.init_run()
        for who, extra in (("done", []), ("ongoing", []), ("v", ["role=verifier"])):
            run(d, "member", who, "id=agent-" + who, *extra)
        run(d, "ready", "done", stdin="done")

        def table(identifier):  # a partial candidate holding done's current report
            with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
                json.dump({"candidate": identifier, "inputs": {"done": [1, None]}, "partial": True, "members": ["done"]}, f)

        table("c1aaaaaaaaaaaaaa")
        run(d, "post", "coordinator", "@v Please test partial candidate c1aaaaaaaaaaaaaa")
        run(d, "read", "v")
        run(d, "pause", "hold")
        out = run(d, "resume")
        assert "@v" in out and "@ongoing" in out, out
        # A finished review is no stopped one.
        run(d, "read", "v")
        run(d, "read", "ongoing")
        run(d, "post", "v", "@coordinator NOT VERIFIED: the check cannot run here")
        assert json.loads(run(d, "show", "--post=4", "--json"))["candidate"] == "c1aaaaaaaaaaaaaa"
        run(d, "pause", "hold")
        out = run(d, "resume")
        assert "@v" not in out and "@ongoing" in out, out
        # A note that only mentions the candidate asks for nothing: the review stays finished.
        run(d, "post", "coordinator", "@v c1aaaaaaaaaaaaaa is in the summary now")
        run(d, "read", "v")
        run(d, "pause", "hold")
        assert "@v" not in run(d, "resume")
        # Asked to run the same candidate again, it owes a new verdict.
        run(d, "post", "coordinator", "@v Please run c1aaaaaaaaaaaaaa again")
        run(d, "read", "v")
        run(d, "read", "ongoing")
        run(d, "pause", "hold")
        assert "@v" in run(d, "resume")
        run(d, "read", "v")
        # A request still unread is a wake already owed: `resume` posts nothing more for it.
        table("c2bbbbbbbbbbbbbb")
        run(d, "post", "coordinator", "@v Please test partial candidate c2bbbbbbbbbbbbbb")
        run(d, "read", "ongoing")
        run(d, "pause", "hold")
        out = run(d, "resume")
        assert "@v" not in out and "@ongoing" in out, out
        assert "@v" in woken(d)

    def test_resume_wakes_a_verifier_whose_not_passed_is_about_a_worker_outside_the_candidate(self):
        d = self.init_run()
        for who, extra in (("done", []), ("ongoing", []), ("v", ["role=verifier"])):
            run(d, "member", who, "id=agent-" + who, *extra)
        run(d, "ready", "done", stdin="done")
        with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:  # a partial candidate holding done
            json.dump({"candidate": "c1aaaaaaaaaaaaaa", "inputs": {"done": [1, None]}, "partial": True, "members": ["done"]}, f)
        run(d, "post", "coordinator", "@v Please test partial candidate c1aaaaaaaaaaaaaa")
        run(d, "read", "v")
        # A NOT PASSED of a worker the candidate does not hold leaves its review unfinished.
        run(d, "post", "v", "@coordinator NOT PASSED @ongoing: its piece breaks the build")
        assert json.loads(run(d, "show", "--post=3", "--json"))["rejects"] == ["ongoing"]
        run(d, "read", "ongoing")
        run(d, "pause", "hold")
        assert "@v" in run(d, "resume")
        # One of a worker it holds finishes it.
        run(d, "read", "v")
        run(d, "post", "v", "@coordinator NOT PASSED @done: the parser test fails")
        run(d, "read", "done")
        run(d, "pause", "hold")
        assert "@v" not in run(d, "resume")

    def test_a_partial_pass_finishes_its_review_and_the_close_names_what_it_held(self):
        project = os.path.join(self.root, "proj")
        os.makedirs(project)

        def git(*args):
            return subprocess.run(["git", "-C", project, *args], check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q", "-b", "main")
        for key, value in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            git("config", key, value)
        with open(os.path.join(project, "file.txt"), "w") as f:
            f.write("v1")
        git("add", "file.txt")
        git("commit", "-q", "-m", "init")
        git("switch", "-q", "-c", "work")
        with open(os.path.join(project, "file.txt"), "w") as f:
            f.write("v2")
        git("commit", "-q", "-am", "work")
        commit = git("rev-parse", "HEAD")
        git("switch", "-q", "main")
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Partial").strip()
        for who, extra in (("w", []), ("other", []), ("v", ["role=verifier"])):
            run(d, "member", who, "id=agent-" + who, *extra)
        run(d, "ready", "w", commit, stdin="done")

        def gate(*args):
            r = subprocess.run([sys.executable, os.path.join(os.path.dirname(BOARD), "verify.py"), d, project, *args],
                               capture_output=True, text=True)
            assert r.returncode == 0, (args, r.stdout, r.stderr)
            return r.stdout

        cand = json.loads(gate("prepare", "isolated", "--check", "true", "--members", "w"))["candidate"]
        run(d, "post", "coordinator", "@v Please test partial candidate " + cand)
        run(d, "read", "v")
        run(d, "pause", "hold")
        assert "@v" in run(d, "resume")
        run(d, "read", "v")
        run(d, "post", "v", "@coordinator " + gate("test", cand, "v").splitlines()[-1])
        run(d, "pause", "hold")
        assert "@v" not in run(d, "resume")
        # A partial pass that still holds at the close is named as one, with the workers it held.
        run(d, "read", "coordinator")
        assert "passed but was partial: it held only @w" in run(d, "close")

    def test_export_and_close_show_a_voided_pass_as_stale(self):
        verify_py = os.path.join(os.path.dirname(BOARD), "verify.py")
        project = os.path.join(self.root, "proj")
        os.makedirs(project)
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Stale").strip()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")

        def gate(*args, ok=True):
            r = subprocess.run([sys.executable, verify_py, d, project, *args], capture_output=True, text=True)
            assert (r.returncode == 0) == ok, (args, r.stdout, r.stderr)
            return r.stdout

        def verification():
            with open(run(d, "export").strip(), encoding="utf-8") as f:
                return next(line for line in f if line.startswith("Candidate "))

        cand = json.loads(gate("prepare", "shared", "--check", "true"))["candidate"]
        line = gate("test", cand, "v").splitlines()[-1]
        run(d, "post", "v", "@coordinator " + line)
        assert "passed, verified by @v" in verification()
        run(d, "revise", "w", "one more fix")
        stale = verification()
        assert "passed earlier, now stale: waiting for READY from @w" in stale and "passed, verified" not in stale, stale
        refused = subprocess.run([sys.executable, BOARD, d, "post", "v", "@coordinator " + line], capture_output=True, text=True)
        assert refused.returncode and "waiting for READY from @w" in refused.stderr, refused.stderr
        run(d, "read", "coordinator")
        assert "passed earlier, now stale: waiting for READY from @w" in run(d, "close")
        assert verification() == stale  # judged while the run was open, not as "the run is closed"
        # A pass that still holds is reported as one.
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Held").strip()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")
        cand = json.loads(gate("prepare", "shared", "--check", "true"))["candidate"]
        run(d, "post", "v", "@coordinator " + gate("test", cand, "v").splitlines()[-1])
        run(d, "read", "coordinator")
        assert "passed verification and was never accepted" in run(d, "close")
        assert "passed, verified by @v" in verification()

    def test_regrouping_moves_no_rejection(self):
        d = self.init_run()
        run(d, "member", "first", "group=platform")
        run(d, "member", "second")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "first", stdin="First piece")
        run(d, "ready", "second", stdin="Second piece")
        run(d, "post", "v", stdin="NOT PASSED @platform\n@second for awareness only")
        assert json.loads(run(d, "show", "--post=3", "--json"))["rejects"] == ["first"]

        def ready():
            return {name for name, view in json.loads(run(d, "attention", "--json"))["members"].items() if view["ready"]}

        assert ready() == {"second"}
        run(d, "member", "first", "group=elsewhere")
        assert ready() == {"second"}
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        members = {"v": {"role": "verifier"}, "a": {"role": "worker"}}
        legacy = {"seq": 1, "agent": "v", "text": "NOT PASSED: broken", "to": ["a"]}
        assert board.rejected(legacy, members) == ["a"]  # a post from before the field is worked out as it was
        assert board.rejected(dict(legacy, rejects=[]), members) == []  # a recorded empty answer stands

    def test_ready_records_the_base_the_pane_diffs_from(self):
        project, commit = self.git_project()

        def git(*args):
            return subprocess.run(["git", "-C", project, *args], check=True, capture_output=True, text=True).stdout.strip()

        d = run(os.path.join(project, ".swarm", "reg"), "init", "Base").strip()
        run(d, "member", "dep")
        run(d, "member", "piece", "depends=dep")
        upstream = commit("dependency", "main", "upstream.txt", "dependency\n")
        commit("piece", "main", "piece.txt", "worker work\n")
        commit("piece", "piece", "second.txt", "more work\n")
        git("merge", "-q", "--no-ff", "--no-edit", upstream)  # as `sync` merges a dependency
        rev = git("rev-parse", "HEAD")
        git("switch", "-q", "main")
        run(d, "ready", "dep", upstream, stdin="upstream")
        run(d, "ready", "piece", rev, stdin="piece")
        base = json.loads(run(d, "show", "--post=2", "--json"))["base"]
        assert base == git("rev-parse", "HEAD")

        def own():
            return set(git("log", "--first-parent", "--no-merges", "--format=", "--name-only", rev, "--not", base).split())

        assert own() == {"piece.txt", "second.txt"}
        git("merge", "-q", "--no-ff", "--no-edit", upstream)
        git("merge", "-q", "--no-ff", "--no-edit", rev)
        assert own() == {"piece.txt", "second.txt"}  # the recorded base still tells the work apart once it is merged
        run(d, "ready", "piece", rev, stdin="piece again")
        # HEAD holds it now, but where the branch started still tells the work apart, the dependency left out
        again = json.loads(run(d, "show", "--post=3", "--json"))
        assert again["base"] == git("rev-parse", "main~2") and again["except"] == [upstream], again
        assert set(git("log", "--first-parent", "--no-merges", "--format=", "--name-only", rev, "--not", again["base"],
                       *again["except"]).split()) == {"piece.txt", "second.txt"}

    def test_a_post_keeps_only_the_optional_fields_that_are_what_they_say(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        import board  # noqa: E402
        full = "a" * 40
        post = {"seq": 1, "agent": "w", "text": "READY", "time": "t", "to": [], "kind": "ready"}
        # a commit that is no full id never reaches git, and costs the post only that field
        kept = dict(post, revision=full, base="--upload-pack=x", **{"except": [full]})
        assert board.is_post(kept) and kept.get("revision") == full and "base" not in kept and "except" not in kept, kept
        kept = dict(post, revision=full, base=full, **{"except": [full, "-x"]})
        assert board.is_post(kept) and kept["base"] == full and "except" not in kept, kept
        kept = dict(post, revision="HEAD")
        assert board.is_post(kept) and "revision" not in kept, kept
        kept = dict(post, revision=full, base=full, **{"except": [full]})
        assert board.is_post(kept) and kept["except"] == [full], kept
        assert not board.is_post(dict(post, seq="1")) and not board.is_post(dict(post, to="w"))
        # rejects is read only as a list of names; anything else falls back to who the verdict reaches
        members = {"v": {"role": "verifier"}, "w": {"role": "worker"}, "x": {"role": "worker"}}
        verdict = {"seq": 2, "agent": "v", "text": "@w NOT PASSED: tabs", "time": "t", "to": ["w"]}
        assert board.rejected(dict(verdict, rejects=[]), members) == []
        assert board.rejected(dict(verdict, rejects=["x"]), members) == ["x"]
        for odd in ("w", None, [1], {"w": 1}):
            assert board.rejected(dict(verdict, rejects=odd), members) == ["w"], odd

    def test_ready_and_sync_hold_no_lock_while_git_works(self):
        project, commit = self.git_project()

        def git(*args, cwd=project):
            return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()

        # A git that takes its time over the trial merge `ready` runs and the merge `sync` makes, as a large
        # repository or a hook would.
        shim, mark = os.path.join(self.root, "shim"), os.path.join(self.root, "mark")
        os.makedirs(shim)
        with open(os.path.join(shim, "git"), "w") as f:
            f.write('#!/bin/sh\ncase " $* " in *" merge-tree "*|*" merge --no-autostash "*) touch "%s"; sleep 1.5;; esac\n'
                    'exec "%s" "$@"\n' % (mark, shutil.which("git")))
        os.chmod(os.path.join(shim, "git"), 0o755)
        env = dict(os.environ, PATH=shim + os.pathsep + os.environ["PATH"])
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Slow git").strip()
        for who, extra in (("up", []), ("down", ["depends=up"]), ("gone", []), ("later", ["depends=up"])):
            run(d, "member", who, *extra)
        run(d, "ready", "up", commit("up", "main", "a", "up\n"), stdin="a is up")

        def slowly(*args, cwd=None):
            if os.path.exists(mark):
                os.unlink(mark)
            started = subprocess.Popen([sys.executable, BOARD, d, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, env=env, cwd=cwd)
            started.stdin.write("done")
            started.stdin.close()
            started.stdin = None  # communicate() on Python 3.12 and older flushes a closed stdin and raises ValueError
            deadline = time.monotonic() + 20
            while not os.path.exists(mark):
                assert started.poll() is None and time.monotonic() < deadline, started.communicate()
                time.sleep(0.05)
            return started

        def quickly(*args):  # another member's command, while git works
            began = time.monotonic()
            out = run(d, *args)
            assert time.monotonic() - began < 1, "the board was locked while git worked"  # under the shim's 1.5 s
            return out

        slow = slowly("ready", "down", commit("down", "up", "b", "down\n"))
        quickly("post", "coordinator", "@up thanks")
        assert slow.communicate()[0].startswith("posted #3") and slow.returncode == 0
        # what changed meanwhile is checked again: a member retired while git worked posts nothing
        slow = slowly("ready", "gone", commit("gone", "main", "c", "gone\n"))
        quickly("member", "gone", "killed=1")
        assert "no longer is one" in slow.communicate()[1] and slow.returncode
        assert "READY" not in run(d, "show", "gone")
        run(d, "member", "reader")
        slow = slowly("ready", "reader", commit("reader", "main", "e", "reader\n"))
        quickly("member", "reader", "writes=0")
        assert "was made read-only while git checked it" in slow.communicate()[1] and slow.returncode
        # a first READY has no earlier report a scope change could withdraw: the work was done for the old scope
        run(d, "member", "scoped", "paths=src")
        slow = slowly("ready", "scoped", commit("scoped", "main", "s", "scoped\n"))
        quickly("member", "scoped", "paths=src,tests")
        assert "assignment changed while git checked" in slow.communicate()[1] and slow.returncode
        assert "READY" not in run(d, "show", "scoped")
        # a change that leaves the scope alone keeps the report valid
        run(d, "member", "tuned", "paths=lib")
        slow = slowly("ready", "tuned", commit("tuned", "main", "t", "tuned\n"))
        quickly("member", "tuned", "model=opus")
        assert slow.communicate()[0].startswith("posted #") and slow.returncode == 0
        # an agent put in its place while git worked is another: the first one's report is not posted for it
        run(d, "member", "swapped", "paths=bin")
        slow = slowly("ready", "swapped", commit("swapped", "main", "w", "swapped\n"))
        state = saved(d)
        state["members"]["swapped"]["id"] = "agent-2"
        with open(os.path.join(d, "members.json"), "w") as f:
            json.dump(state, f)
        assert "assignment changed while git checked" in slow.communicate()[1] and slow.returncode
        assert "READY" not in run(d, "show", "swapped")
        # sync records the merges it made, and says the scope moved under it
        tree = os.path.join(self.root, "moved")
        run(d, "member", "moved", "depends=up")
        git("worktree", "add", "-q", "-b", "moved", tree, "main")
        slow = slowly("sync", "moved", cwd=tree)
        quickly("member", "moved", "paths=docs")
        out, err = slow.communicate()
        assert slow.returncode and "assignment changed while sync ran" in err, (out, err)
        assert saved(d)["members"]["moved"]["synced_deps"] == {"up": git("rev-parse", "up")}
        # an agent put in the member's place while sync ran works elsewhere: this checkout's merges are not its record
        tree = os.path.join(self.root, "handed")
        run(d, "member", "handed", "depends=up")
        git("worktree", "add", "-q", "-b", "handed", tree, "main")
        slow = slowly("sync", "handed", cwd=tree)
        state = saved(d)
        state["members"]["handed"]["id"] = "agent-2"
        with open(os.path.join(d, "members.json"), "w") as f:
            json.dump(state, f)
        out, err = slow.communicate()
        assert slow.returncode and "assignment changed while sync ran" in err, (out, err)
        assert "synced_deps" not in saved(d)["members"]["handed"]
        # a branch that merely ends at the reported commit is no evidence of where the work began when there are two
        run(d, "member", "twin")
        first = commit("twin", "main", "tw", "twin\n")
        git("branch", "other", first)  # begun inside the work: taken for its start, it would hide the first commit
        tip = commit("twin", "twin", "tw2", "more\n")
        git("branch", "-f", "other", tip)
        git("checkout", "-q", "main")  # the project's HEAD does not hold the work yet
        run(d, "ready", "twin", tip, stdin="twin is ready")
        assert json.loads(run(d, "tail").splitlines()[-1])["base"] == git("rev-parse", "main")
        # sync merges in the member's own worktree, and records the merge on the board as it stands afterwards
        tree = os.path.join(self.root, "later")
        git("worktree", "add", "-q", "-b", "later", tree, "main")
        slow = slowly("sync", "later", cwd=tree)
        # one sync a member at a time: a second would write its own list of merges over the first one's
        second = subprocess.run([sys.executable, BOARD, d, "sync", "later"], cwd=tree, capture_output=True, text=True, env=env)
        assert second.returncode and "another sync for @later is still running" in second.stderr, second.stderr
        quickly("post", "coordinator", "@later sync is running")
        assert "synced" in slow.communicate()[0] and slow.returncode == 0
        state = saved(d)
        assert state["members"]["later"]["synced_deps"] == {"up": git("rev-parse", "up")}
        assert state["members"]["later"]["start"] == git("rev-parse", "main")
        assert "@later sync is running" in run(d, "show", "later")

    def test_of_two_overlapping_readies_the_later_names_their_clash(self):
        project, commit = self.git_project()
        # A git whose trial merge takes as long as SLOW says, so the two reports overlap in a known order.
        shim, mark = os.path.join(self.root, "shim"), os.path.join(self.root, "mark")
        os.makedirs(shim)
        with open(os.path.join(shim, "git"), "w") as f:
            f.write('#!/bin/sh\ncase " $* " in *" merge-tree "*) touch "%s"; sleep "${SLOW:-0}";; esac\nexec "%s" "$@"\n'
                    % (mark, shutil.which("git")))
        os.chmod(os.path.join(shim, "git"), 0o755)
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Overlap").strip()
        for who in ("base", "first", "second"):
            run(d, "member", who)
        run(d, "ready", "base", commit("base", "main", "base.txt", "base\n"), stdin="base")  # a peer to compare with
        one, two = commit("first", "main", "same", "first\n"), commit("second", "main", "same", "second\n")

        report = os.path.join(self.root, "report")
        with open(report, "w") as f:
            f.write("done")

        def ready(who, revision, slow):
            env = dict(os.environ, PATH=shim + os.pathsep + os.environ["PATH"], SLOW=slow)
            with open(report) as stdin:
                return subprocess.Popen([sys.executable, BOARD, d, "ready", who, revision], stdin=stdin,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

        early = ready("first", one, "2")
        deadline = time.monotonic() + 20
        while not os.path.exists(mark):
            assert early.poll() is None and time.monotonic() < deadline, early.communicate()
            time.sleep(0.05)
        late = ready("second", two, "4")  # starts while the first is in git, and posts after it
        assert early.communicate()[0].startswith("posted #2") and early.returncode == 0
        out, err = late.communicate()
        assert late.returncode == 0 and "conflict: @first's READY #2" in out, (out, err)
        assert json.loads(run(d, "show", "--post=3", "--json"))["conflicts"]["first"]["files"] == ["same"]

    def test_ready_and_sync_name_the_remedy_that_fits(self):
        project, commit = self.git_project()

        def git(*args, cwd=project):
            return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()

        d = run(os.path.join(project, ".swarm", "reg"), "init", "Remedies").strip()
        for who, extra in (("up", []), ("down", ["depends=up"]), ("solo", [])):
            run(d, "member", who, *extra)
        up = commit("up", "main", "a", "up\n")
        # git reads a commit ID in either case: so does the board, which keeps one
        run(d, "ready", "up", up.upper(), stdin="a is up")
        assert json.loads(run(d, "show", "--post=1", "--json"))["revision"] == up
        # a commit only a separate clone holds is none verification can merge
        clone = os.path.join(self.root, "clone")
        subprocess.run(["git", "clone", "-q", project, clone], check=True, capture_output=True)
        for key, value in (("user.name", "T"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false")):
            git("config", key, value, cwd=clone)
        with open(os.path.join(clone, "solo.txt"), "w") as f:
            f.write("solo")
        git("add", "solo.txt", cwd=clone)
        git("commit", "-q", "-m", "solo", cwd=clone)
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "solo", "HEAD"], input="done", capture_output=True,
                                 text=True, cwd=clone)
        assert refused.returncode and "no commit in the project's repository" in refused.stderr, refused.stderr
        # a merge Git cannot sign is aborted, and the message says what to configure
        git("switch", "-q", "main")
        tree = os.path.join(self.root, "down")
        git("worktree", "add", "-q", "-b", "down", tree, "main")
        env = dict(os.environ, GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="commit.gpgsign", GIT_CONFIG_VALUE_0="true",
                   GIT_CONFIG_KEY_1="gpg.program", GIT_CONFIG_VALUE_1="false")
        failed = subprocess.run([sys.executable, BOARD, d, "sync", "down"], capture_output=True, text=True, cwd=tree, env=env)
        assert failed.returncode and "so it was aborted" in failed.stderr and "signing key" in failed.stderr, failed.stderr
        assert git("status", "--porcelain", cwd=tree) == "" and git("rev-parse", "HEAD", cwd=tree) == git("rev-parse", "main")

    def test_ready_base_and_except_hold_only_the_members_own_work(self):
        project, commit = self.git_project()

        def git(*args, cwd=project):
            return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()

        d = run(os.path.join(project, ".swarm", "reg"), "init", "Own work").strip()
        for who, extra in (("dep", []), ("ff", ["depends=dep"]), ("w", []), ("x", []), ("y", []), ("v", ["role=verifier"])):
            run(d, "member", who, *extra)

        def ready(who, revision, cwd=None):
            report = "done\n" + "\n".join("F%d: fixed — the commit holds it" % n for n in range(1, 9))
            r = subprocess.run([sys.executable, BOARD, d, "ready", who, revision], input=report, capture_output=True,
                               text=True, cwd=cwd)
            assert r.returncode == 0 and r.stdout.startswith("posted #"), r.stderr
            return int(r.stdout.split()[1][1:])

        def own(seq):  # what the pane shows: git log --first-parent --no-merges REVISION --not BASE EXCEPT...
            post = json.loads(run(d, "show", "--post=%d" % seq, "--json"))
            return set(git("log", "--first-parent", "--no-merges", "--format=", "--name-only", post["revision"], "--not",
                           post["base"], *post.get("except", [])).split())

        # a dependency fast-forwarded into the branch sits on its first-parent line: `except` leaves it out
        up = commit("dep", "main", "dep.txt", "dep\n")
        git("switch", "-q", "-c", "ff", "main")
        git("merge", "-q", "--ff-only", up)
        mine = commit("ff", "ff", "ff.txt", "ff\n")
        git("switch", "-q", "main")
        ready("dep", up)
        assert own(ready("ff", mine)) == {"ff.txt"}
        # a branch, several commits long, from a side ref the project's HEAD lacks: the base is where it started
        commit("develop", "main", "side.txt", "side\n")
        commit("w", "develop", "w1.txt", "1\n")
        first = commit("w", "w", "w2.txt", "2\n")
        git("switch", "-q", "main")
        seq = ready("w", first)
        assert json.loads(run(d, "show", "--post=%d" % seq, "--json"))["base"] == git("rev-parse", "develop")
        assert own(seq) == {"w1.txt", "w2.txt"}
        # rejected, fixed and reported again: the whole branch is still the work
        run(d, "post", "v", "@w NOT PASSED: w2 is wrong")
        fixed = commit("w", "w", "w3.txt", "3\n")
        git("switch", "-q", "main")
        again = ready("w", fixed)
        assert own(again) == {"w1.txt", "w2.txt", "w3.txt"}
        # a fix begun on a new branch made from the reported work: that branch began inside the work, not before it
        git("switch", "-q", "-c", "w-fix", "w")
        refix = commit("w-fix", "w-fix", "w4.txt", "4\n")
        git("switch", "-q", "main")
        assert own(ready("w", refix)) == {"w1.txt", "w2.txt", "w3.txt", "w4.txt"}
        # from a worktree on another side ref: `ready HEAD` records where its branch began, and a later READY of a
        # commit no branch ends at is told apart from there
        commit("topic", "main", "topic.txt", "topic\n")
        git("switch", "-q", "main")
        tree = os.path.join(self.root, "agent-x")
        git("worktree", "add", "-q", "-b", "agent-x", tree, "topic")
        for name in ("x1.txt", "x2.txt"):
            with open(os.path.join(tree, name), "w") as f:
                f.write(name)
            git("add", name, cwd=tree)
            git("commit", "-q", "-m", name, cwd=tree)
            if name == "x1.txt":
                assert own(ready("x", "HEAD", cwd=tree)) == {"x1.txt"}
                assert saved(d)["members"]["x"]["start"] == git("rev-parse", "topic")
                x1 = git("rev-parse", "HEAD", cwd=tree)
        assert own(ready("x", x1)) == {"x1.txt"}
        # a detached worktree began where its own HEAD reflog starts
        detached = os.path.join(self.root, "agent-y")
        git("worktree", "add", "-q", "--detach", detached, "topic")
        with open(os.path.join(detached, "y1.txt"), "w") as f:
            f.write("y1")
        git("add", "y1.txt", cwd=detached)
        git("commit", "-q", "-m", "y1", cwd=detached)
        assert own(ready("y", "HEAD", cwd=detached)) == {"y1.txt"}
        assert saved(d)["members"]["y"]["start"] == git("rev-parse", "topic")
        # integrated into HEAD, the recorded range still tells the work apart, and a new READY records one too
        git("merge", "-q", "--no-ff", "--no-edit", refix)
        assert own(again) == {"w1.txt", "w2.txt", "w3.txt"}
        assert own(ready("w", refix)) == {"w1.txt", "w2.txt", "w3.txt", "w4.txt"}

    def test_prune_keeps_an_integration_worktree_holding_ignored_files(self):
        git = lambda *a: subprocess.run(["git", "-C", self.root, *a], check=True, capture_output=True)
        git("init", "-q")
        with open(os.path.join(self.root, ".gitignore"), "w", encoding="utf-8") as f:
            f.write("*.env\nbuild/\n")
        git("add", ".gitignore")
        git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x")
        d = self.init_run()
        run(d, "close")
        wt = os.path.join(d, "integration-abc")
        git("worktree", "add", "-q", "--detach", wt)
        os.makedirs(os.path.join(wt, "build"))
        for name in ("local.env", os.path.join("build", "out.bin")):  # an ignored file, and one in an ignored folder
            with open(os.path.join(wt, name), "w", encoding="utf-8") as f:
                f.write("only here\n")
        self.init_run("shown")
        plan = run(self.swarm, "prune", "--days=0", "--dry-run")
        assert "kept " + wt + ": worktree has uncommitted changes" in plan and "would remove worktree" not in plan, plan
        real = run(self.swarm, "prune", "--days=0")
        assert "kept " + wt in real and "remove worktree" not in real, real
        assert os.path.isfile(os.path.join(wt, "local.env")) and os.path.isfile(os.path.join(wt, "build", "out.bin")), real
        git("worktree", "remove", "--force", wt)

    def test_a_new_agent_starts_with_no_context_held_by_the_old_one(self):
        d = self.init_run()
        run(d, "member", "scout", "profile=investigator", "writes=0", "id=a1")

        def hold(agent):
            key = hashlib.sha256(("swarm-agent:" + agent).encode()).hexdigest()
            self.turns = getattr(self, "turns", 0) + 1
            run(d, "account", "%064x" % self.turns, key, "10", "mention:1,1,1,1,250000")
            assert saved(d)["members"]["scout"]["held"] == 250000
        hold("a1")
        run(d, "member", "scout", "id=a2")
        assert "held" not in saved(d)["members"]["scout"], saved(d)
        hold("a2")
        run(d, "started", "scout", "a3", "a2")
        assert "held" not in saved(d)["members"]["scout"], saved(d)

    def test_the_users_budget_drops_the_allocated_member_caps(self):
        for figure in ("0", "9000000"):
            d = self.init_run("cap" + figure)
            run(d, "member", "w", "owns=src")
            run(d, "member", "w", "id=agent-w")  # the allocation freezes, and w keeps a share to be stopped at
            assert saved(d)["members"]["w"]["alloc"], saved(d)
            run(d, "limit", "budget=" + figure)
            assert "alloc" not in saved(d)["members"]["w"], saved(d)
            assert "member_paused" not in self.account(d, "agent-w", 2_000_000)

    def test_a_derived_effort_stays_derived_when_a_member_starts(self):
        d = self.init_run()
        run(d, "member", "w", "size=s", "effort=high")
        run(d, "member", "w", "id=agent-w", "effort=")  # the named effort is cleared: the size gives it again
        w = saved(d)["members"]["w"]
        assert w.get("sized") == "1" and w.get("effort"), w
        run(d, "replace", "w", "w2", "id=agent-w2")  # started as it is registered: what it runs on is recorded
        w2 = saved(d)["members"]["w2"]
        assert w2.get("effort") and w2.get("model") and w2.get("sized") == "1", w2

    def test_a_failed_sync_keeps_what_an_earlier_sync_merged(self):
        project = os.path.join(self.root, "proj")
        os.makedirs(project)

        def git(*args, cwd=None):
            return subprocess.run(["git", "-C", cwd or project, *args], check=True, capture_output=True, text=True).stdout.strip()

        def commit(start, name, text):
            git("switch", "-q", "--detach", start)
            with open(os.path.join(project, name), "w") as f:
                f.write(text)
            git("add", name)
            git("commit", "-q", "-m", "change " + name)
            return git("rev-parse", "HEAD")

        git("init", "-q", "-b", "main")
        for key, value in (("user.name", "T"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false")):
            git("config", key, value)
        with open(os.path.join(project, "a"), "w") as f:
            f.write("0\n")
        git("add", ".")
        git("commit", "-q", "-m", "base")
        d = run(os.path.join(project, ".swarm", "reg"), "init", "Sync").strip()
        wt = os.path.join(self.root, "wt")
        git("worktree", "add", "-q", "--detach", wt, "main")
        run(d, "member", "up")
        run(d, "member", "down", "depends=up")
        c1 = commit("main", "a", "one\n")
        run(d, "ready", "up", c1, stdin="a is one")
        sync = lambda ok=True: subprocess.run([sys.executable, BOARD, d, "sync", "down"], capture_output=True, text=True, cwd=wt)
        assert sync().returncode == 0
        assert saved(d)["members"]["down"]["synced_deps"] == {"up": c1}
        c2 = commit("main", "a", "two\n")  # rebuilt from main: it conflicts with c1, which down's HEAD holds
        run(d, "ready", "up", c2, stdin="a is two")
        failed = sync()
        assert failed.returncode != 0 and "aborted" in failed.stderr, failed.stderr
        assert saved(d)["members"]["down"]["synced_deps"] == {"up": c1}, saved(d)["members"]["down"]

    def test_a_workers_status_note_after_the_verifiers_brief_starts_no_verifier(self):
        d = self.init_run()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "post", "coordinator", stdin="@w @v BRIEF\nThe parser")
        run(d, "post", "w", "@v @coordinator build still running, nothing to test yet")
        items = json.loads(run(d, "attention", "--json"))["items"]
        assert "v" not in [i["member"] for i in items if i["kind"] == "unstarted"], items


class FindingLedger(unittest.TestCase):
    """A verifier's defects get ids from the board, the worker answers each, and only the verifier closes one."""

    def _run(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        d = run(os.path.join(temp.name, ".swarm", "led"), "init", "Ledger").strip()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")
        return d

    def _post(self, d, seq):
        return json.loads(run(d, "show", "--post=%d" % seq, "--json"))

    def test_indented_code_neither_resolves_nor_answers_a_finding(self):
        d = self._run()
        run(d, "post", "v", stdin="@w NOT PASSED. First defect.")
        run(d, "ready", "w", stdin="F1: fixed — save.py:7")
        out = run(d, "post", "v", stdin="@w NOT PASSED\n\n    F1: resolved\n\n- A second defect")
        assert "recorded: F2" in out, out
        run(d, "ready", "w", stdin="F2: fixed — save.py:12", ok=False)
        run(d, "ready", "w", stdin="    F1: fixed — this is pasted output\nF2: fixed — save.py:12", ok=False)
        run(d, "ready", "w", stdin="F1: fixed — save.py:7\nF2: fixed — save.py:12")

    def test_each_defect_gets_an_id_and_the_worker_must_answer_it(self):
        d = self._run()
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- the retry sends two fetches\n  - seen in the retry test\n"
                                        "- F9: the key is not normalised\n")
        assert "recorded: F1, F2" in out, out
        post = self._post(d, 2)
        assert post["findings"] == ["F1", "F2"] and post["text"].split("\n")[1:] == [
            "- F1: the retry sends two fetches", "  - seen in the retry test", "- F2: the key is not normalised"], post
        # A report that passes over an open id, or answers one with no evidence, is refused in the same step.
        for report in ("fixed both", "F1: fixed — src/retry.py:4, the retry test passes", "F1: fixed — a.py:1\nF2: disputed"):
            refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input=report, capture_output=True, text=True)
            assert refused.returncode and "F2" in refused.stderr and "Nothing was posted" in refused.stderr, refused.stderr
        run(d, "ready", "w", stdin="F1: fixed — src/retry.py:4, the retry test passes\nF2: disputed — api.py:42 normalises it")
        # The next verdict rules by id: one closed, one raised again, one new. Only the open ones are owed an answer.
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- F1: resolved\n- F2: the job path skips api.py:42\n- a third defect\n")
        assert "recorded: F3" in out, out
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="F3: fixed — c.py:9", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F2 (the job path skips api.py:42)." in refused.stderr, refused.stderr

    def test_a_verdict_in_prose_is_one_finding_and_a_pass_closes_all(self):
        d = self._run()
        assert "recorded: F1" in run(d, "post", "v", "@w NOT PASSED. In src/jobs.py:67 the retry passes a raw key.")
        assert self._post(d, 2)["text"] == "@w NOT PASSED [F1]. In src/jobs.py:67 the retry passes a raw key."
        run(d, "ready", "w", stdin="F1: fixed — src/jobs.py:67 now calls canonical()")
        # A verdict that only rules on a known id raises nothing new, and "fixed" is the worker's word: it closes nothing.
        out = run(d, "post", "v", "@w NOT PASSED. F1: not fixed — the retry test still sees two fetches")
        assert "recorded" not in out and "findings" not in self._post(d, 4), out
        run(d, "post", "v", "@coordinator the worker says F1: fixed")
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="again", capture_output=True, text=True)
        assert refused.returncode and "F1" in refused.stderr
        run(d, "post", "v", "@w checked again\nF1: resolved — the retry test passes now")  # any post of the verifier's closes
        run(d, "ready", "w", stdin="nothing left")
        # A verdict that closes an old id and says what else is wrong raises that as a new one.
        out = run(d, "post", "v", stdin="@w NOT PASSED: the save now loses data\nF1: resolved")
        assert "recorded: F2" in out, out
        # An answer quoted in a pasted log is no answer.
        quoted = "see the log\n```\nF2: fixed — old run passed\n```"
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input=quoted, capture_output=True, text=True)
        assert refused.returncode and "F2 (the save now loses data)" in refused.stderr, refused.stderr

    def test_a_dispute_the_verifier_keeps_open_pauses_the_run(self):
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: disputed — handler.py:30 logs and re-raises it")
        out = run(d, "post", "v", "@w NOT PASSED [F1]. It is swallowed on the retry path, handler.py:52.")
        assert "paused: @w disputes F1 and @v keeps it open" in out and saved(d)["paused"] == "@w disputes F1 and @v keeps it open", out
        item = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        assert len(item) == 1 and item[0]["member"] == "w" and "F1" in item[0]["text"] and "consultant" in item[0]["text"], item
        # Settled by the verifier's ruling, the dispute is gone; a fix kept open is rework, no dispute.
        run(d, "resume")
        # Once the worker gives in and fixes it, nobody disputes anything: the next review says where it stands.
        run(d, "ready", "w", stdin="F1: fixed — handler.py:52 re-raises on the retry path too")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        run(d, "ready", "w", stdin="F1: disputed — on second thought it re-raises already, handler.py:52")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        # A third NOT PASSED in a row pauses for that reason, as before; the dispute it also keeps open is listed.
        assert "paused: @w failed verification 3 times in a row" in run(d, "post", "v", "@w NOT PASSED [F1]. Swallowed: see the log.")
        run(d, "resume")
        run(d, "post", "v", "@w F1: resolved — a ruling shares its line with nothing")
        assert [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        run(d, "post", "v", "@w settled\nF1: resolved — the coordinator showed the retry path re-raises")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: fixed — handler.py:30 re-raises")
        assert "paused" not in run(d, "post", "v", "@w NOT PASSED [F1]. Still swallowed on the retry path.")
        # Silence is no ruling: a verdict that raises only something else keeps no dispute open.
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: disputed — handler.py:30 logs and re-raises it")
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- the retry path leaks a handle")
        assert "recorded: F2" in out and "paused" not in out, out
        assert not [i for i in self._items(d) if i["kind"] != "rework"], self._items(d)
        # Two owners of one finding answer each for itself: one that fixed its part settles no dispute of the other's.
        d = self._run()
        run(d, "member", "x")
        run(d, "ready", "x", stdin="done")
        run(d, "post", "v", "@w @x NOT PASSED. The seam between them drops the key.")
        run(d, "ready", "w", stdin="F1: disputed — w.py:9 passes the key on")
        run(d, "ready", "x", stdin="F1: fixed — x.py:3 reads it now")
        # A verdict about one owner leaves the other's answer to be judged, and names who disputes.
        assert "paused" not in run(d, "post", "v", "@x NOT PASSED [F1]. x.py:3 reads the wrong key.")
        out = run(d, "post", "v", "@w NOT PASSED [F1]. w.py:9 passes None.")
        assert "paused: @w disputes F1 and @v keeps it open" in out, out
        item = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        assert [i["member"] for i in item] == ["w"] and "tell @w to fix it" in item[0]["text"], item

    def test_a_dispute_stays_listed_through_a_review_the_worker_has_not_answered(self):
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: disputed — handler.py:30 logs and re-raises it")
        run(d, "post", "v", "@w NOT PASSED [F1]. It is swallowed on the retry path, handler.py:52.")
        run(d, "resume")
        # Another review keeps it open before the worker says anything new: the dispute it judged still stands.
        run(d, "post", "v", "@w NOT PASSED [F1]. Still swallowed on the retry path.")
        item = [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]
        assert [i["member"] for i in item] == ["w"], item

    def test_a_partial_pass_still_covers_the_findings_its_worker_hands_to_a_successor(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        try:
            import board  # noqa: E402
        finally:
            sys.path.remove(os.path.dirname(BOARD))
        members = {"coordinator": {"role": "coordinator"}, "w": {"role": "worker", "killed": "1", "replaced_by": "w2"},
                   "w2": {"role": "worker"}, "v": {"role": "verifier"}}
        posts = [{"seq": 1, "agent": "v", "text": "@w NOT PASSED [F1]. The key is dropped.", "to": ["w"], "rejects": ["w"],
                  "findings": ["F1"], "candidate": "c1"},
                 {"seq": 2, "agent": "v", "text": "@coordinator VERIFIED c2", "to": ["coordinator"], "rules": True,
                  "partial": True, "members": ["w"]}]
        assert not board.ledger({"members": members}, posts)["F1"]["open"]

    def test_quoted_output_raises_nothing_and_a_successor_inherits_the_findings(self):
        d = self._run()
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- the retry sends two fetches\n```\n- FAILED test_retry\nF7: resolved\n"
                                        "- 2 fetches\n```\n    - an indented trace line\n- the key is raw\n")
        assert "recorded: F1, F2" in out and "F3" not in out, out
        assert self._post(d, 2)["text"].count(": ") == 3 and "- FAILED test_retry" in self._post(d, 2)["text"]
        # A shorter fence inside a longer one closes nothing: the ruling after it is still quoted output.
        run(d, "post", "v", "@w a log\n````\n```\nF1: resolved\n````")
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="F2: fixed — api.py:42", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F1 (" in refused.stderr, refused.stderr
        # The stronger model that takes the work over takes its defects too, and its brief lists them.
        run(d, "replace", "w", "w2", "model=opus")
        brief = self._post(d, 4)["text"]
        assert "open findings on this work are yours" in brief and "- F1 (#2): the retry sends two fetches" in brief \
            and "- F2 (#2): the key is raw" in brief, brief
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w2"], input="all done", capture_output=True, text=True)
        assert refused.returncode and "F1 (the retry sends two fetches); F2 (the key is raw)" in refused.stderr, refused.stderr
        run(d, "ready", "w2", stdin="F1: fixed — retry.py:4\nF2: fixed — api.py:42")
        # Retired with no successor, a member takes its findings with it.
        run(d, "post", "v", "@w2 NOT PASSED. Still two fetches.")
        run(d, "member", "w2", "killed=1")
        assert not [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] == "dispute"]

    def test_a_new_agent_under_a_verifiers_name_tested_nothing(self):
        d = self._run()
        path = os.path.join(d, "members.json")
        with open(path) as f:
            state = json.load(f)
        state["members"]["v"]["tested"] = "c" * 16  # as verify.py records the candidate under test
        with open(path, "w") as f:
            json.dump(state, f)
        run(d, "member", "v", "id=agent-2")
        with open(path) as f:
            assert "tested" not in json.load(f)["members"]["v"]

    def test_a_role_change_keeps_the_count_of_failed_verifications(self):
        d = self._run()

        def counted():
            return [item for item in json.loads(run(d, "attention", "--json"))["items"] if item["kind"] == "rework"]
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: fixed — handler.py:30")
        run(d, "post", "v", "@w NOT PASSED. F1: handler.py:30 still swallows it")
        before = counted()
        assert before, run(d, "attention", "--json")
        run(d, "member", "v", "role=worker")
        assert counted() == before

    def test_another_workers_id_on_a_bullet_is_a_new_defect(self):
        d = self._run()
        run(d, "member", "b")
        run(d, "ready", "b", stdin="done")
        assert "recorded: F1" in run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        out = run(d, "post", "v", stdin="@b NOT PASSED\n- F1: src/b.py still fails\n")
        assert "recorded: F2" in out, out
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "b"], input="done", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F2 (src/b.py still fails)" in refused.stderr, refused.stderr

    def test_a_role_change_erases_no_finding_and_a_second_verdict_can_rule_first(self):
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "member", "v", "role=worker")  # the verdict was a verifier's when it was written
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="done", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F1 (" in refused.stderr, refused.stderr
        # Its ruling stays a verifier's too, and a worker's own closes nothing.
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "post", "w", "@v it is fine\nF1: resolved")
        run(d, "member", "x")
        run(d, "post", "x", "@v agreed\nF1: resolved")
        run(d, "member", "x", "role=verifier")  # what it wrote as a worker is no ruling now either
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="done", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F1 (" in refused.stderr, refused.stderr
        run(d, "post", "v", "@w checked\nF1: resolved")
        run(d, "member", "v", "role=worker")
        run(d, "ready", "w", stdin="done")
        # Two verdicts on one candidate are one review, but the first of them to rule on an answer is the ruling on it.
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: disputed — handler.py:30 logs and re-raises it")
        with open(os.path.join(d, "verification.json"), "w") as f:
            json.dump({"candidate": "c" * 16, "inputs": {"w": [3, None]}}, f)
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- the retry path leaks a handle")
        assert "recorded: F2" in out and "paused" not in out, out
        out = run(d, "post", "v", "@w NOT PASSED [F1]. It is swallowed on the retry path, handler.py:52.")
        assert "paused: @w disputes F1 and @v keeps it open" in out and self._post(d, 5)["candidate"] == self._post(d, 4)["candidate"], out

    def test_a_late_verdict_on_a_replaced_candidate_rules_on_nothing(self):
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. The handler swallows the error.")
        run(d, "ready", "w", stdin="F1: fixed — handler.py:30 re-raises")
        old, new = "a" * 16, "c" * 16
        with open(os.path.join(d, "verification.json"), "w") as f:
            json.dump({"candidate": new, "inputs": {"w": [3, None]},
                       "superseded": [{"candidate": old, "inputs": {"w": [1, None]}}]}, f)
        # It reviewed the report the new candidate replaced: it raises no finding, closes none and pauses nothing.
        out = run(d, "post", "v", stdin="@w NOT PASSED %s\n- a defect of the old work\nF1: resolved" % old)
        post = self._post(d, 4)
        assert "recorded:" not in out and "paused" not in out and post["rejects"] == [] and "findings" not in post, (out, post)
        assert "- a defect of the old work" in post["text"] and not self._items(d)
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="more", capture_output=True, text=True)
        assert refused.returncode and "unanswered: F1 (" in refused.stderr and "F2" not in refused.stderr, refused.stderr

    def _items(self, d):
        return [i for i in json.loads(run(d, "attention", "--json"))["items"] if i["kind"] in ("dispute", "rework", "paused")]

    def test_the_answer_and_ruling_rules_read_the_shapes_they_were_written_for(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        try:
            import board
            assert board.rulings_in("F9999: resolved\nF10000: open") == {"F9999": "resolved", "F10000": "open"}
            assert board.answers_in("F10000: fixed — a.py:1", {"F10000"}) == {"F10000": ("fixed", "a.py:1")}
            assert board.tag_findings("@w NOT PASSED\n- F10000: again\n- new", {"F10000"}, 10001)[1] == ["F10001"]
            assert board.rulings_in("F1: resolved\n- [F2] closed — test passes\nF3: verified the bug still reproduces\n"
                                    "F4: resolved\nwe think F4: still open\nF5 score is low\nprev-F6: resolved") == {
                "F1": "resolved", "F2": "resolved", "F4": "open"}
            assert board.answers_in("F1: fixed — a.py:3 F2: disputed - t.py:9 asserts it\n[F3] — fixed\nF4: fixed: b.py\n"
                                    "F4: disputed: no\nF7: fixed — x", {"F1", "F2", "F3", "F4"}) == {
                "F1": ("fixed", "a.py:3"), "F2": ("disputed", "t.py:9 asserts it")}
        finally:
            sys.path.remove(os.path.dirname(BOARD))

    def test_prose_defect_alongside_bulleted_ruling_and_empty_rest(self):
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. First defect.")
        run(d, "ready", "w", stdin="F1: fixed — a.py:1")
        # Prose defect on line 0 with a bulleted ruling still gets tagged as F2.
        out = run(d, "post", "v", stdin="@w NOT PASSED: the save now loses data\n- F1: resolved")
        assert "recorded: F2" in out, out
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="ok", capture_output=True, text=True)
        assert refused.returncode and "F2 (the save now loses data)" in refused.stderr, refused.stderr
        run(d, "ready", "w", stdin="F2: fixed — save.py:10")
        # Closing a finding with a bulleted ruling and no line-0 prose (even with trailing punctuation) creates no empty finding.
        out = run(d, "post", "v", stdin="@w NOT PASSED\n- F2: resolved")
        assert "recorded:" not in out and "findings" not in self._post(d, 6), (out, self._post(d, 6))
        run(d, "ready", "w", stdin="all clear")
        run(d, "post", "v", "@w NOT PASSED. Another defect.")
        run(d, "ready", "w", stdin="F3: fixed — save.py:12")
        out = run(d, "post", "v", stdin="@w NOT PASSED:\n- F3: resolved")
        assert "recorded:" not in out and "findings" not in self._post(d, int(out.split()[1][1:])), out
        run(d, "ready", "w", stdin="all clear")
        # Trailing routing mention after NOT PASSED with no defect prose creates no finding, while defect text after it does.
        run(d, "post", "v", "@w NOT PASSED. Open defect.")
        run(d, "ready", "w", stdin="F4: fixed — save.py:15")
        out = run(d, "post", "v", stdin="NOT PASSED @w\n- F4: resolved")
        assert "recorded:" not in out and "findings" not in self._post(d, int(out.split()[1][1:])), out
        run(d, "ready", "w", stdin="clear")
        run(d, "post", "v", "@w NOT PASSED. Another defect.")
        run(d, "ready", "w", stdin="F5: fixed — save.py:20")
        out = run(d, "post", "v", stdin="NOT PASSED @w: the save loses data\n- F5: resolved")
        assert "recorded: F6" in out, out
        refused = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="ok", capture_output=True, text=True)
        assert refused.returncode and "F6" in refused.stderr and "the save loses data" in refused.stderr, refused.stderr
        run(d, "ready", "w", stdin="F6: fixed — save.py:25")

    def test_fenced_ignores_single_line_backtick_spans_and_deep_indents(self):
        sys.path.insert(0, os.path.dirname(BOARD))
        try:
            import board
            assert board.fenced(["```foo()``` failed", "- real defect", "F1: resolved"]) == set()
            assert board.fenced(["    ```", "four spaces is code block", "    ```"]) == set()
            assert board.fenced(["\t```", "tab is code block", "\t```"]) == set()
            assert board.fenced(["   ```", "three spaces is a fence", "   ```"]) == {0, 1, 2}
        finally:
            sys.path.remove(os.path.dirname(BOARD))
        d = self._run()
        run(d, "post", "v", "@w NOT PASSED. First defect.")
        run(d, "ready", "w", stdin="F1: fixed — a.py:1")
        out = run(d, "post", "v", stdin="@w NOT PASSED\n```foo()``` failed\n- real defect\nF1: resolved")
        assert "recorded: F2" in out, out
        run(d, "ready", "w", stdin="F2: fixed — b.py:2")


class SoftDependencies(unittest.TestCase):
    """after= waits for a member to finish, with a report or without one; depends= needs the report."""

    def test_confirming_a_finding_unblocks_after(self):
        with tempfile.TemporaryDirectory() as t:
            d = run(os.path.join(t, ".swarm", "soft"), "init", "Finding prerequisite").strip()
            run(d, "member", "inv", "profile=investigator")
            run(d, "member", "next", "after=inv")
            run(d, "ready", "inv", stdin="Root cause in the parser")
            member = saved(d)["members"]["next"]
            assert member["depends"] == member["after"] == "inv", member
            before = json.loads(run(d, "attention", "--json"))
            assert before["members"]["next"]["blocked_on"] == ["inv"], before
            review = next(i for i in before["items"] if i["kind"] == "review")
            finding = json.loads(run(d, "show", "--post=%d" % review["seq"], "--json"))
            assert finding["to"] == ["coordinator"] and "@coordinator" not in finding["text"], finding
            run(d, "confirm", "inv", str(review["seq"]))
            assert json.loads(run(d, "attention", "--json"))["members"]["next"]["blocked_on"] == []

    def test_a_retired_members_rejected_commit_rides_in_on_nobodys(self):
        with tempfile.TemporaryDirectory() as t:
            project = os.path.realpath(t)
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}

            def git(*args):
                return subprocess.run(["git", "-C", project, *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

            def commit(branch, start, name):
                git("switch", "-q", "-C", branch, start)
                with open(os.path.join(project, name), "w") as f:
                    f.write(name + "\n")
                git("add", "--", name)
                git("commit", "-q", "-m", "add " + name)
                revision = git("rev-parse", "HEAD")
                git("switch", "-q", "main")
                return revision

            def ready(who, revision):
                return subprocess.run([sys.executable, BOARD, d, "ready", who, revision], input="done", capture_output=True, text=True)
            git("init", "-q", "-b", "main")
            for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
                git("config", *setting)
            git("commit", "-q", "--allow-empty", "-m", "init")
            d = run(os.path.join(project, ".swarm", "ride"), "init", "Ride").strip()
            for who, extra in (("a", []), ("b", ["after=a"]), ("v", ["role=verifier"])):
                run(d, "member", who, *extra)
            first = commit("a", "main", "a.txt")
            assert ready("a", first).returncode == 0
            built = commit("b", "a", "b.txt")  # on top of a's work
            assert ready("b", built).returncode == 0
            run(d, "post", "v", "@a NOT PASSED. a.txt is wrong.")
            run(d, "member", "a", "killed=1")
            refused = ready("b", built)
            assert refused.returncode and "still holds @a's commit %s" % first[:12] in refused.stderr, refused.stderr
            # `sync` says so first, in either form, from the worktree the member would otherwise go on building in.
            tree = os.path.join(project, "b-tree")
            git("worktree", "add", "-q", "--detach", tree, built)
            for form in ([], ["--check-only"]):
                synced = subprocess.run([sys.executable, BOARD, d, "sync", "b", *form], capture_output=True, text=True, cwd=tree)
                assert synced.returncode and "HEAD still holds @a's commit %s" % first[:12] in synced.stderr \
                    and "in sync" not in synced.stdout, (form, synced.stdout, synced.stderr)
            git("-C", tree, "switch", "-q", "--detach", "main")
            clean = subprocess.run([sys.executable, BOARD, d, "sync", "b", "--check-only"], capture_output=True, text=True, cwd=tree)
            assert clean.returncode == 0 and "in sync" in clean.stdout, (clean.stdout, clean.stderr)
            git("worktree", "remove", "--force", tree)
            rebuilt = commit("b2", "main", "b.txt")
            assert ready("b", rebuilt).returncode == 0, ready("b", rebuilt).stderr
            # A dependency's commit that holds the retired member's work is not merged: said before, not at `ready`.
            for who, extra in (("x", []), ("y", []), ("z", ["after=x", "depends=y"])):
                run(d, "member", who, *extra)
            left = commit("x", "main", "x.txt")
            assert ready("x", left).returncode == 0
            on_x = commit("y", "x", "y.txt")
            assert ready("y", on_x).returncode == 0
            run(d, "post", "v", "@x NOT PASSED. x.txt is wrong.")
            run(d, "member", "x", "killed=1")
            tree = os.path.join(project, "z-tree")
            git("worktree", "add", "-q", "--detach", tree, "main")
            synced = subprocess.run([sys.executable, BOARD, d, "sync", "z"], capture_output=True, text=True, cwd=tree)
            assert synced.returncode and "@y's commit %s holds @x's commit %s" % (on_x[:12], left[:12]) in synced.stderr, \
                (synced.stdout, synced.stderr)
            assert git("-C", tree, "rev-parse", "HEAD") == git("rev-parse", "main")
            git("worktree", "remove", "--force", tree)
            # Further down the chain too: a member that waits for the retired one through another holds none of it.
            for who, extra in (("u", []), ("b1", ["after=u"]), ("c1", ["after=b1"])):
                run(d, "member", who, *extra)
            gone = commit("u", "main", "u.txt")
            assert ready("u", gone).returncode == 0
            assert ready("b1", commit("b1", "u", "b1.txt")).returncode == 0
            below = commit("c1", "b1", "c1.txt")
            assert ready("c1", below).returncode == 0
            run(d, "post", "v", "@u NOT PASSED. u.txt is wrong.")
            run(d, "member", "u", "killed=1")
            clean = commit("b1-clean", "main", "b1.txt")
            assert ready("b1", clean).returncode == 0
            git("switch", "-q", "-C", "c1-merged", below)
            git("merge", "-q", "--no-edit", clean)
            merged = git("rev-parse", "HEAD")
            git("switch", "-q", "main")
            refused = ready("c1", merged)
            assert refused.returncode and "still holds @u's commit %s" % gone[:12] in refused.stderr, refused.stderr
            # The assembled candidate is read as well: @y waits for nobody, and its commit was built on @x's.
            prepared = subprocess.run([sys.executable, os.path.join(os.path.dirname(BOARD), "verify.py"), d, project, "prepare",
                                       "isolated", "--check", "true", "--members", "y"], capture_output=True, text=True)
            assert prepared.returncode and "holds @x's commit %s" % left[:12] in prepared.stderr, prepared.stderr
            # A member put in a retired one's place takes over its work: what the successor's READY leaves out stays out.
            for who, extra in (("m", []), ("n", ["after=m"])):
                run(d, "member", who, *extra)
            rejected = commit("m", "main", "m.txt")
            assert ready("m", rejected).returncode == 0
            on_m = commit("n", "m", "n.txt")
            assert ready("n", on_m).returncode == 0
            raised = re.search(r"recorded: (F\d+)", run(d, "post", "v", "@m NOT PASSED. m.txt is wrong."))[1]
            run(d, "replace", "m", "m2")
            answer = raised + ": fixed — m.txt:1"

            def report(revision):
                return subprocess.run([sys.executable, BOARD, d, "ready", "m2", revision], input=answer, capture_output=True, text=True)
            anew = commit("m2", "main", "m2.txt")  # the successor began again, without the rejected commit
            assert report(anew).returncode == 0, report(anew).stderr
            git("switch", "-q", "-C", "n-both", on_m)
            git("merge", "-q", "--no-edit", anew)
            both = git("rev-parse", "HEAD")
            git("switch", "-q", "main")
            refused = ready("n", both)
            assert refused.returncode and "still holds @m's commit %s" % rejected[:12] in refused.stderr, refused.stderr
            onward = commit("m2-on", rejected, "m3.txt")  # the successor went on from it: the commit is its own now
            assert report(onward).returncode == 0, report(onward).stderr
            assert ready("n", commit("n-on", onward, "n2.txt")).returncode == 0
            # A replaced member's report that stood is good work still, whatever its successor then builds.
            for who, extra in (("g", []), ("h", ["after=g"])):
                run(d, "member", who, *extra)
            passed = commit("g", "main", "g.txt")
            assert ready("g", passed).returncode == 0
            on_g = commit("h", "g", "h.txt")
            run(d, "replace", "g", "g2")
            assert subprocess.run([sys.executable, BOARD, d, "ready", "g2", commit("g2", "main", "g2.txt")], input="done",
                                  capture_output=True, text=True).returncode == 0
            git("switch", "-q", "-C", "h-both", on_g)
            git("merge", "-q", "--no-edit", "g2")
            held_both = git("rev-parse", "HEAD")
            git("switch", "-q", "main")
            assert ready("h", held_both).returncode == 0, ready("h", held_both).stderr
            # Git failing to say is an error, never a no; a commit the repository no longer holds is in no history.
            sys.path.insert(0, os.path.dirname(BOARD))
            try:
                import board
                assert board.is_ancestor(project, "0" * 40, anew, True) is False
                with self.assertRaises(SystemExit):
                    board.is_ancestor(project, anew, "no-such-revision", True)
            finally:
                sys.path.remove(os.path.dirname(BOARD))
            # Work that stood when its member was retired stays: the dependent built on a passed report.
            for who, extra in (("c", []), ("e", ["after=c"])):
                run(d, "member", who, *extra)
            assert ready("c", commit("c", "main", "c.txt")).returncode == 0
            good = commit("c", "c", "c2.txt")  # a follow-up on its own first report: both are the work that stood
            assert ready("c", good).returncode == 0
            on_it = commit("e", "c", "e.txt")
            assert ready("e", on_it).returncode == 0
            run(d, "member", "c", "killed=1")
            again = ready("e", on_it)
            assert again.returncode == 0, again.stderr
            # A report that stopped counting because what it was built on was rejected did not stand either.
            for who, extra in (("p", []), ("q", ["depends=p"]), ("r", ["after=q"])):
                run(d, "member", who, *extra)
            assert ready("p", commit("p", "main", "p.txt")).returncode == 0
            middle = commit("q", "p", "q.txt")
            assert ready("q", middle).returncode == 0
            top = commit("r", "q", "r.txt")
            assert ready("r", top).returncode == 0
            run(d, "post", "v", "@p NOT PASSED. p.txt is wrong.")
            run(d, "member", "q", "killed=1")
            refused = ready("r", top)
            assert refused.returncode and "still holds @q's commit %s" % middle[:12] in refused.stderr, refused.stderr
            # A replacement adds to what its predecessor came after, and is asked only about the names it is given.
            run(d, "member", "s", "after=e")
            run(d, "member", "e", "killed=1")
            run(d, "replace", "s", "s2", "after=r")
            assert saved(d)["members"]["s2"]["after"] == "e,r" and saved(d)["members"]["s2"]["depends"] == "e,r"
            run(d, "replace", "v", "v2", "after=r", ok=False)  # a verifier waits for no member, however it is put

    def test_retiring_a_member_that_never_started_wakes_no_verifier(self):
        with tempfile.TemporaryDirectory() as t:
            d = run(os.path.join(t, ".swarm", "idle"), "init", "Idle").strip()
            run(d, "member", "a")
            run(d, "member", "v", "role=verifier")
            run(d, "ready", "a", stdin="a done")
            # Seen live: the verifier woke on the notice only to answer that nothing changes.
            run(d, "member", "kody")
            board = os.path.join(d, "board.jsonl")
            before = open(board, encoding="utf-8").read()
            run(d, "member", "kody", "killed=1")
            assert open(board, encoding="utf-8").read() == before
            # One that started still says so: its work may be in what the verifier holds.
            run(d, "member", "kody-2", "id=late")
            out = run(d, "member", "kody-2", "killed=1")
            post = json.loads(run(d, "show", "--post=%d" % int(out.split()[1][1:]), "--json"))
            assert post["to"] == ["v"] and "@kody-2 was retired and reports nothing" in post["text"], post

    def test_a_fan_in_goes_on_when_a_member_it_comes_after_is_retired(self):
        with tempfile.TemporaryDirectory() as t:
            d = run(os.path.join(t, ".swarm", "soft"), "init", "Fan-in").strip()
            for name in ("a", "b", "c"):
                run(d, "member", name)
            run(d, "member", "synth", "depends=c", "after=a,b")
            run(d, "member", "hard", "depends=a")
            assert saved(d)["members"]["synth"]["depends"] == "c,a,b" and saved(d)["members"]["synth"]["after"] == "a,b"
            run(d, "member", "a", "after=synth", ok=False)  # still an edge: a cycle is one
            run(d, "ready", "c", stdin="c done")
            run(d, "ready", "a", stdin="a done")
            assert "waiting for b" in subprocess.run([sys.executable, BOARD, d, "ready", "synth"], input="x",
                                                     capture_output=True, text=True).stderr
            view = json.loads(run(d, "attention", "--json"))
            assert view["members"]["synth"]["blocked_on"] == ["b"], view["members"]["synth"]
            # Retiring the last one it came after starts it, and says what is missing; nothing lists it as blocked.
            out = run(d, "member", "b", "killed=1")
            post = json.loads(run(d, "show", "--post=%d" % int(out.split()[1][1:]), "--json"))
            assert post["to"] == ["synth"] and "@b was retired and reports nothing" in post["text"], post
            view = json.loads(run(d, "attention", "--json"))
            assert not [i for i in view["items"] if i["kind"] == "blocked" and i["member"] == "synth"]
            run(d, "ready", "synth", stdin="from a and c; b is missing")
            # A report it needs is another matter: retiring that member leaves the waiter blocked, as before.
            out = run(d, "member", "a", "killed=1")
            view = json.loads(run(d, "attention", "--json"))
            assert [i["member"] for i in view["items"] if i["kind"] == "blocked"] == ["hard"], view["items"]
            # A report made before the retirement was built on the retired member's work: it stands no longer, and
            # the member is told to go on and report anew.
            assert view["members"]["synth"]["ready"] is False, view["members"]["synth"]
            assert "@a was retired" in json.loads(run(d, "show", "--post=%d" % int(out.split()[1][1:]), "--json"))["text"]
            run(d, "ready", "synth", stdin="from c alone; a and b are missing")
            assert json.loads(run(d, "attention", "--json"))["members"]["synth"]["ready"] is True
            # A successor takes the place in after= too, and depends= given alone keeps after= within it.
            run(d, "member", "x")
            run(d, "member", "late", "after=x")
            run(d, "replace", "x", "y")
            assert saved(d)["members"]["late"]["after"] == "y" and saved(d)["members"]["late"]["depends"] == "y"
            run(d, "member", "late", "depends=")
            assert "after" not in saved(d)["members"]["late"]


class EngineRegressions(unittest.TestCase):
    """Regressions for engine correctness and edge-case behavior."""

    def _fresh(self, name="reg"):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return run(os.path.join(temp.name, ".swarm", name), "init", "Regressions").strip(), temp.name

    def test_all_not_passed_excludes_consultant_and_investigator_and_consultant_ready(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1")
        run(d, "member", "inv", "profile=investigator", "writes=0")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")
        run(d, "ready", "adv", stdin="advice")
        out = run(d, "post", "v", stdin="@all NOT PASSED\n- broken")
        assert "recorded: F1" in out, out
        post = json.loads(run(d, "show", "--post=3", "--json"))
        assert post["rejects"] == ["w"], post
        run(d, "ready", "adv", stdin="updated advice")
        # Even a legacy post recording a consultant in rejects never blocks its ready.
        board_path = os.path.join(d, "board.jsonl")
        with open(board_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"seq": 5, "agent": "v", "text": "@adv NOT PASSED [F2]: legacy",
                                "time": "2026-01-01T00:00:00+0000", "to": ["adv"],
                                "rejects": ["adv"], "findings": ["F2"]}) + "\n")
        run(d, "ready", "adv", stdin="still unblocked")

    def test_read_max_bytes_defers_new_posts_and_omits_star_on_routine_ready(self):
        d, _ = self._fresh()
        run(d, "member", "w1")
        run(d, "member", "w2", "depends=w1")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w1", stdin="done\nchecked\nw1 detail " + "x" * 260)
        run(d, "read", "w2", "--headers")
        run(d, "post", "coordinator", "@w2 hello")
        out = run(d, "read", "w2", "--max-bytes=350")
        assert "earlier report(s) you work from" in out, out
        assert "no new posts" not in out, out
        assert "1 new post(s) deferred to next page" in out, out
        assert "1 more post(s) remain" in out, out
        # Routine worker READY summarized for coordinator must not carry '* '.
        run(d, "post", "w1", "@coordinator non-routine note")
        coord = run(d, "read", "coordinator")
        assert "[full: show --post=1]" in coord, coord
        routine_line = next(line for line in coord.splitlines() if "#1 " in line and "@w1" in line)
        assert not routine_line.startswith("* "), coord
        note_header = next(line for line in coord.splitlines() if "#3 " in line and "@w1" in line)
        assert note_header.startswith("* "), coord

    def test_post_verdict_after_acceptance_prints_no_candidate_none(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="done")
        with open(os.path.join(d, "verification.json"), "w", encoding="utf-8") as f:
            json.dump({"candidate": "newcand1111111111", "accepted": True, "inputs": {"w": [1, None]},
                       "superseded": [{"candidate": "oldcand0000000000", "inputs": {"w": [1, None]}}]}, f)
        out = run(d, "post", "v", "@w NOT VERIFIED oldcand0000000000: late note")
        assert "candidate None" not in out, out

    def test_carried_matches_prepare_when_project_head_holds_retired_commit(self):
        d, root = self._fresh()
        project = os.path.realpath(root)
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}

        def git(*args, cwd=project):
            return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

        def commit(branch, start, name):
            git("switch", "-q", "-C", branch, start)
            with open(os.path.join(project, name), "w") as f:
                f.write(name + "\n")
            git("add", "--", name)
            git("commit", "-q", "-m", "add " + name)
            rev = git("rev-parse", "HEAD")
            git("switch", "-q", "main")
            return rev

        git("init", "-q", "-b", "main")
        for setting in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            git("config", *setting)
        git("commit", "-q", "--allow-empty", "-m", "init")
        d = run(os.path.join(project, ".swarm", "car"), "init", "Carried").strip()
        for who, extra in (("a", []), ("b", ["after=a"]), ("v", ["role=verifier"])):
            run(d, "member", who, *extra)
        first = commit("a", "main", "a.txt")
        run(d, "ready", "a", first, stdin="a done")
        built = commit("b", "a", "b.txt")
        run(d, "post", "v", "@a NOT PASSED. a.txt is wrong.")
        run(d, "member", "a", "killed=1")
        tree = os.path.join(project, "b-tree")
        git("worktree", "add", "-q", "--detach", tree, built)
        # Before project HEAD holds `first`, both ready and sync refuse `built`.
        refused_ready = subprocess.run([sys.executable, BOARD, d, "ready", "b", built], input="done", capture_output=True, text=True)
        assert refused_ready.returncode and "still holds @a's commit" in refused_ready.stderr, refused_ready.stderr
        refused_sync = subprocess.run([sys.executable, BOARD, d, "sync", "b", "--check-only"], capture_output=True, text=True, cwd=tree)
        assert refused_sync.returncode and "HEAD still holds @a's commit" in refused_sync.stderr, refused_sync.stderr
        # Once project HEAD includes `first`, both ready and sync succeed, matching verify.py prepare.
        git("merge", "-q", "--ff-only", first)
        assert subprocess.run([sys.executable, BOARD, d, "sync", "b", "--check-only"], capture_output=True, text=True, cwd=tree).returncode == 0
        ok_ready = subprocess.run([sys.executable, BOARD, d, "ready", "b", built], input="done", capture_output=True, text=True)
        assert ok_ready.returncode == 0, ok_ready.stderr
        git("worktree", "remove", "--force", tree)

    def test_killed_idempotent_and_status_excludes_delivered_clipped_and_scope_typo(self):
        d, _ = self._fresh()
        run(d, "member", "a")
        run(d, "member", "b", "after=a")
        out1 = run(d, "member", "a", "killed=1")
        assert "posted #1" in out1, out1
        out2 = run(d, "member", "a", "killed=1")
        assert "posted" not in out2, out2
        with open(os.path.join(d, "board.jsonl"), encoding="utf-8") as f:
            assert len(f.readlines()) == 1
        # Scope change message says "Review your scope", not "Review its scope".
        run(d, "ready", "b", stdin="done")
        run(d, "member", "b", "owns=new-part")
        revise_post = json.loads(run(d, "show", "--post=3", "--json"))["text"]
        assert "Review your scope and report again." in revise_post and "Review its scope" not in revise_post, revise_post
        # It arrives ahead of the coordinator's instruction, and says so: no turn ends with a post about it alone.
        assert "instruction follows in a later post: read the board again" in revise_post, revise_post
        # Status omits internal delivered/clipped lists.
        run(d, "member", "c", "depends=b")
        run(d, "read", "c")
        state = saved(d)
        state["members"]["c"]["clipped"] = [2]
        with open(os.path.join(d, "members.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        st = run(d, "status")
        assert "delivered=" not in st and "clipped=" not in st, st

    def test_post_and_ready_release_lock_while_reading_stdin(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        for cmd in (["post", "w"], ["ready", "w"]):
            proc = subprocess.Popen([sys.executable, BOARD, d, *cmd], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                # Give the child a moment to either block on stdin (fixed) or lock `.lock` and block (buggy).
                time.sleep(0.3)
                began = time.monotonic()
                st = subprocess.run([sys.executable, BOARD, d, "status"], capture_output=True, text=True, timeout=5)
                assert st.returncode == 0, st.stderr
                ping = subprocess.run([sys.executable, BOARD, d, "post", "coordinator", "ping during " + cmd[0]],
                                      capture_output=True, text=True, timeout=5)
                assert ping.returncode == 0, ping.stderr
                assert time.monotonic() - began < 4, "lock held while waiting on stdin for " + cmd[0]
                out, err = proc.communicate("from pipe\n", timeout=10)
                assert proc.returncode == 0 and "posted #" in out, (cmd, out, err)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()

    def test_post_rejects_sender_id_change_while_reading_stdin(self):
        d, _ = self._fresh()
        run(d, "member", "w", "id=agent-1")
        proc = subprocess.Popen([sys.executable, BOARD, d, "post", "w"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.3)
            run(d, "started", "w", "agent-2", "agent-1")
            out, err = proc.communicate("stale agent post\n", timeout=10)
            assert proc.returncode != 0 and "agent changed while reading stdin" in err, (out, err)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        with open(os.path.join(d, "board.jsonl"), encoding="utf-8") as f:
            assert f.readlines() == []
        # Posting still works when sender id is unchanged, and for coordinator.
        for who in ("w", "coordinator"):
            ok = subprocess.Popen([sys.executable, BOARD, d, "post", who], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                out, err = ok.communicate("valid post\n", timeout=10)
                assert ok.returncode == 0 and "posted #" in out, (who, out, err)
            finally:
                if ok.poll() is None:
                    ok.kill()
                    ok.wait()

    def test_report_only_ready_rejects_stale_dependency_version_after_stdin(self):
        d, _ = self._fresh()
        run(d, "member", "a")
        run(d, "member", "b", "depends=a")
        run(d, "ready", "a", stdin="a v1")
        proc = subprocess.Popen([sys.executable, BOARD, d, "ready", "b"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.3)
            run(d, "ready", "a", stdin="a v2")
            out, err = proc.communicate("b built on v1\n", timeout=10)
            assert proc.returncode != 0 and "changed while reading stdin" in err, (out, err)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        assert not json.loads(run(d, "attention", "--json"))["members"]["b"]["ready"]
        ok = subprocess.Popen([sys.executable, BOARD, d, "ready", "b"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = ok.communicate("b built on v2\n", timeout=10)
            assert ok.returncode == 0 and "posted #" in out, (out, err)
        finally:
            if ok.poll() is None:
                ok.kill()
                ok.wait()

    def test_pending_ready_cannot_supersede_a_rejection_posted_while_reading(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="initial work")
        run(d, "post", "v", stdin="@w NOT PASSED\n- the retry leaks a handle")
        report = "F1: fixed — the retry closes the handle\n"
        run(d, "ready", "w", stdin=report)
        proc = subprocess.Popen([sys.executable, BOARD, d, "ready", "w"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.3)
            run(d, "post", "v", stdin="@w NOT PASSED\n- F1: the retry still leaks a handle")
            out, err = proc.communicate(report, timeout=10)
            assert proc.returncode != 0 and "rejected while reading stdin" in err, (out, err)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        assert not json.loads(run(d, "attention", "--json"))["members"]["w"]["ready"]
        run(d, "ready", "w", stdin="F1: fixed — both retry branches now close the handle")

    def test_multiline_prose_not_passed_creates_finding(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="initial work")
        out = run(d, "post", "v", stdin="@w NOT PASSED\nThe save loses data.")
        assert "recorded: F1" in out, out
        blocked = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="done again", capture_output=True, text=True)
        assert blocked.returncode != 0 and "F1" in blocked.stderr and "The save loses data." in blocked.stderr, blocked.stderr
        run(d, "ready", "w", stdin="F1: fixed save — added flush test")
        # Multiline prose defect alongside a resolved bullet ruling allocates F2 and preserves line-1 summary (not @w).
        out2 = run(d, "post", "v", stdin="NOT PASSED @w\nThe retry drops headers.\n- F1: resolved")
        assert "recorded: F2" in out2, out2
        blocked2 = subprocess.run([sys.executable, BOARD, d, "ready", "w"], input="done again", capture_output=True, text=True)
        assert blocked2.returncode != 0 and "F2" in blocked2.stderr and "The retry drops headers." in blocked2.stderr and "(@w)" not in blocked2.stderr, blocked2.stderr

    def test_consultant_addressed_verdict_does_not_withdraw_other_worker_ready(self):
        d, _ = self._fresh()
        run(d, "member", "w")
        run(d, "member", "adv", "profile=architect", "writes=0", "consult=1")
        run(d, "member", "v", "role=verifier")
        run(d, "ready", "w", stdin="worker ready")
        assert json.loads(run(d, "attention", "--json"))["members"]["w"]["ready"]
        # Explicitly addressing consultant @adv on line 1 while mentioning @w in body must not withdraw @w's READY.
        run(d, "post", "v", stdin="@adv NOT PASSED: revisit design\nSee @w for context")
        assert json.loads(run(d, "attention", "--json"))["members"]["w"]["ready"]
        # Addressing @coordinator on line 1 with no worker target still falls back to body worker @w.
        run(d, "post", "v", stdin="@coordinator NOT PASSED\n@w broke the build")
        assert not json.loads(run(d, "attention", "--json"))["members"]["w"]["ready"]


if __name__ == "__main__":
    unittest.main()

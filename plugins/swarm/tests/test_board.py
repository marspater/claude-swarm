#!/usr/bin/env python3
"""Check for board.py: python3 test_board.py"""
import sys

sys.dont_write_bytecode = True  # a test run leaves no __pycache__ in the plugin folder
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

BOARD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "skills", "swarm", "scripts", "board.py")


def saved(d):
    with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
        return json.load(f)


def run(d, *args, stdin=None, ok=True):
    r = subprocess.run([sys.executable, BOARD, d, *args], input=stdin, capture_output=True, text=True)
    assert (r.returncode == 0) == ok, (args, r.stdout, r.stderr)
    return r.stdout


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
        run(d, "post", "parser", "@late JSON lines")
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
        run(d, "ready", "art", "a" * 40, stdin="icons drawn")  # unlike a specialist, its report may carry a commit
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
        cut = run(d, "tail", "300").encode()
        assert 0 < len(cut) <= 300 and whole.endswith(cut) and whole[len(whole) - len(cut) - 1:len(whole) - len(cut)] == b"\n"
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
        assert not json.loads(run(budget_run, "account", "2" * 64, "coordinator", "40"))["paused"]
        run(budget_run, "pause", "awaiting a decision")
        assert not json.loads(run(budget_run, "account", "3" * 64, actor, "21"))["paused"]
        assert "awaiting a decision" in run(budget_run, "attention")
        run(budget_run, "resume", ok=False)
        run(budget_run, "account", "bad key", actor, "1", ok=False)
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
        # a plain reply answers what is still open, whatever post numbers or protocol words it mentions
        run(third, "post", "coordinator", "@w change a.py as in #2, yes to b.py, and post READY when done")
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
        # an investigator's confirmed finding reaches the verifier as well as the dependants
        run(edge, "member", "probe", "profile=investigator", "writes=0", "model=sonnet")
        run(edge, "ready", "probe", stdin="cause found")
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            finding = len(f.readlines())
        run(edge, "confirm", "probe", str(finding))
        with open(os.path.join(edge, "board.jsonl"), encoding="utf-8") as f:
            assert "v" in json.loads(f.readlines()[-1])["to"]
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

    # A budget set at or below what is already spent pauses the run and says so.
    money = fresh("Budget")
    run(money, "account", "1" * 64, "coordinator", "50")
    assert "paused: token budget of 40 spent" in run(money, "limit", "budget=40")
    assert "(paused)" in run(money, "status") and "token budget of 40 spent" in run(money, "attention")
    run(money, "limit", "budget=60")
    run(money, "resume")
    run(money, "pause", "awaiting a decision")
    run(money, "account", "2" * 64, "coordinator", "20")
    assert "token budget is spent (70 of 60)" in run(money, "attention")  # the pause names another reason
    # a turn that ends after the run closed is not added to it, and the caller still gets its JSON
    run(money, "close")
    late = json.loads(run(money, "account", "3" * 64, "coordinator", "500"))
    assert late == {"title": "Budget", "total": 70, "budget": 60, "paused": False, "closed": True}
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
    # closing with a candidate that passed and was never accepted says so
    with open(os.path.join(loop, "verification.json"), "w") as f:
        json.dump({"candidate": "abc", "verified_by": "v"}, f)
    run(loop, "read", "coordinator")
    assert "passed verification and was never accepted" in run(loop, "close")
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
        run(d, "post", "c", "@a 8080")
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
        run(d, "post", "other", "@asker yes")
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


if __name__ == "__main__":
    scenario()
    print("ok")

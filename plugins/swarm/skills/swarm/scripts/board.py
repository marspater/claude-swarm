#!/usr/bin/env python3
"""Shared message board for a swarm: numbered posts, @mentions, unread cursors.

usage: board.py DIR init TITLE                    prints the run folder it created; use that as DIR from then on
       board.py DIR member NAME [key=value ...]   add or update (role= profile= writes= consult= group= depends= after= owns= paths= model= effort= size=<s|m|l> id= backend= isolated= budget=<tokens> killed=1)
       board.py DIR limit [key=value ...]         set run limits: max_workers= max_members= budget=<tokens> member_budget=<tokens> <model>=<types>
       board.py DIR plan                          the team as a table: type, model, effort, dependencies, ownership
       board.py DIR attention [--json]            what needs someone: a paused run or member, unread posts, unanswered questions, findings to review, rework, disputed findings, heavy spend, loops, unstarted, unreachable, ignoring or blocked members, stale verification, conflicting commits
       board.py DIR retry NAME                    let delivery try an unreachable or unresponsive member again
       board.py DIR replace OLD NEW [key=value ...]  retire OLD and register NEW with its brief, dependencies and history
       board.py DIR post FROM [TEXT]              TEXT from stdin when omitted; @all, @group, @verifiers and @dependents (of FROM) reach several
       board.py DIR read ME                       print posts ME has not read, mark them read: posts that mention ME, and the current READYs ME works from, in full; others as one line
       board.py DIR read ME --all                 the same, every post in full
       board.py DIR read ME --headers             the same, every post as one line
       board.py DIR read ME --max-bytes=N          page the unread output without consuming the next unread post; a post longer than a page is cut and names the show command that prints it whole
       board.py DIR read coordinator --attention  the same, then what attention prints once nothing unread is left
       board.py DIR show [NAME | --post=N [--json]]  print history, optionally for one member or post; marks nothing
       board.py DIR ready NAME [COMMIT|HEAD]      record readiness and tell the coordinator, the dependents it lets start, and the verifiers once every worker is ready; HEAD is the checkout's own commit
       board.py DIR sync NAME [--check-only]      from NAME's checkout, merge the READY commits of its dependencies that HEAD lacks; --check-only lists them
       board.py DIR confirm NAME SEQ              accept an investigator finding and release its dependents
       board.py DIR revise NAME [REASON]           withdraw readiness before starting a fix
       board.py DIR wake                          list pending wakes, including the post sequence
       board.py DIR claim NAME ID SEQ             claim delivery through SEQ and print its token
       board.py DIR woke NAME SEQ TOKEN           acknowledge a successful delivery
       board.py DIR rearm TURN_MS ID...           after agent ID's turn of TURN_MS: wake it again for mentions it left unread
       board.py DIR pause [REASON]                 pause automation while awaiting a decision
       board.py DIR resume [NAME]                  resume automation, or one member its own token budget paused
       board.py DIR bind KEY                       bind this run to a private lookup key
       board.py .swarm restore KEY                 find the run for a private lookup key
       board.py .swarm adopt KEY NAME [HINT]       bind the one open run that has member NAME; exit 3 when ambiguous, 4 when an open run lacks it, 5 when HINT names an ineligible run
       board.py .swarm locate KEY NAME [HINT]      find the one open run that has member NAME without binding it
       board.py .swarm agent-run KEY ID [ADDRESS]  find the run owning agent ID, or the address it was started under
       board.py DIR started NAME ID EXPECTED [isolated=0|1]  record a started agent's ID if it matches EXPECTED
       board.py DIR close                         mark the run finished
       board.py DIR kill [REASON]                 end the run now, whatever its state: retire every member, close it, post SHUTDOWN
       board.py DIR account TURN_HASH ACTOR_KEY TOKENS  record a completed turn once
       board.py DIR status                        members, unread counts, who mentioned whom
       board.py DIR export [--out=PATH]           write a Markdown report of the run (default DIR/summary.md) and print its path
       board.py .swarm prune [--days=N] [--dry-run]  remove integration checkouts no candidate needs, archive closed runs idle for N days (default 14)
       board.py DIR tail [BYTES]                  the newest whole posts of board.jsonl within BYTES (default 3000000), raw

`init` takes <project>/.swarm/<name> and creates <project>/.swarm/<name>-<timestamp>, so every
run has its own folder. A run folder holds board.jsonl, one {"seq","agent","text","time","to"}
per line (a coordinator's BRIEF adds "addressed", whom its first line assigned when it was posted), and members.json: {"title","closed","killed","binding","limits","usage","accepted_seq","pending_post","members":{name:{role,group,model,id,
last_read_seq,last_nudged_seq,wake_claim,told,killed,replaced_by,retired_at,stood,after,budget,paused,synced_deps,start,tested,
delivered,clipped}}}; a retired member's "stood" is the commit that counted as READY when it left; a verifier's "tested" is the
candidate it is testing and has posted no verdict on, and "delivered" the current READY posts it works from that
`read` has shown it in full ("clipped" those it could show only in part). A run's "killed" is the reason `kill` closed it. A READY with a commit records "revision",
and "base" and "except" when it can: the reporter's own work is `git log --first-parent --no-merges REVISION --not
BASE EXCEPT...`.
"""
import hashlib
import fcntl  # ponytail: POSIX only; swap in msvcrt.locking if Windows support is needed
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter

# The late `import verify` would otherwise write __pycache__ into the plugin folder, which may be read-only.
sys.dont_write_bytecode = True

# @name at a word start; an email or a path (a@b.com, pkg/@scope) is not a mention
MENTION = re.compile(r"(?<![A-Za-z0-9_.@/])@([A-Za-z][A-Za-z0-9_-]*)")
# A post's author named as its source: a citing word, the name, then the post's number. Mirrored in hooks/roster.ts.
# "and" or a comma only carries a citation on ("per @a #5 and @b #6"): between two addressees it cites nothing.
_CITE = r"@[A-Za-z][A-Za-z0-9_-]*(?:['’]s)?[ \t]*\(?(?:(?:posts?|in)[ \t]+)?#[0-9]+\)?"
CITED = re.compile(r"(?:\b(?:from|per|see|by|in|of|via|cf\.?)[ \t]+|\()%s(?:[ \t]*(?:,|and|&)[ \t]*%s)*" % (_CITE, _CITE), re.IGNORECASE)
NAME = re.compile(r"[a-z](?:[a-z0-9_-]*[a-z0-9])?")  # ends in a letter or digit: "@name-" in prose is @name
COORDINATOR = "coordinator"
WAKE_LEASE_SECONDS = 15
WAKE_ATTEMPTS = 3
REWORK_WARNING, REWORK_PAUSE = 2, 3  # failed verification cycles in a row
SPEND_FLOOR = 200_000  # a share of less says nothing about the run
SPEND_SHARE, PAIR_SHARE = 1 / 2, 3 / 4  # of the run's tokens with three or more members using any, of the pair's with two
# Spent by a worker or verifier without posting or reading: it is going round in circles. A step is one model response,
# so a long stretch of honest edits stays well under it. Each step re-reads the member's conversation, some 14,000
# charged tokens at 100,000 held, so the token count catches heavy spinning earlier too.
LOOP_STEPS, LOOP_TOKENS = 150, 750_000
AGENT_STATE = ("wake_claim", "last_nudged_seq", "told", "delivered", "clipped", "tested", "held")  # what one agent read, was told and holds: not its successor's
# No run is without a bound: one made with no budget named pauses here and the user is asked. Seen live: a run nobody
# had capped spent 7.8M tokens before the user looked. Five members on a task of a few files use about this much.
DEFAULT_BUDGET = 3_000_000
TURNS_KEPT = 2000
COMMIT = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
RUN_NAME = re.compile(r"[a-zA-Z0-9_.-]+-\d{8}-\d{6}x*")
BIND_KEY = re.compile(r"[a-f0-9]{64}")
# The first line says what a post is. Mentions before the word stay on that line: a word on line two is prose.
# ASCII word characters, as in MENTION and the pane's mirror: "@José READY" is no report to either.
REPORT_WORD = re.compile(r"^(?:@[\w-]+[ \t,:]*)*(READY|REVISE|BRIEF|SHUTDOWN|FINDING|VERIFIED|NOT (?:PASSED|VERIFIED))\b", re.ASCII)
# Code spans and URLs carry question marks that ask nothing, as do `name?: type` and `a?.b` left outside a span.
# A fence closes on a run at least as long as the one that opened it, and the whole run goes with it, so a longer
# fence can quote a shorter one.
# What is taken out leaves a space: with nothing there, the words on either side would join into one.
# A URL's scheme starts where its word does: tried from every letter, one long unbroken token (a hash, base64, a
# minified line) costs the square of its length each time a post is read for questions.
# Blanks and line starts are JavaScript's, as the pane reads them: its \s has U+FEFF and lacks U+001C-U+001F and U+0085,
# and its ^ also follows a CR, U+2028 or U+2029.
_BLANK = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_LINE = "(?:^|(?<=[\r\u2028\u2029]))"
QUOTED = re.compile(r"(?P<f>`{3,}).*?(?P=f)`*|%s {0,3}(?P<t>~{3,}).*?%s {0,3}(?P=t)~*|(?P<s>`+)[^\n]*?(?P=s)"
                    r"|(?<![A-Za-z0-9_])[A-Za-z0-9_]+://[^%s]+?(?=[.,;:!)]*(?:\?(?=[%s]|$))?(?:[%s]|$))"
                    % (_LINE, _LINE, _BLANK, _BLANK, _BLANK), re.DOTALL | re.MULTILINE)
# `c ? a : b` asks nothing, and neither does `a ?? b`; "sure??" and "A? (Option A : yes)" do.
# One blank after the mark and one before the colon are enough to look for: the class between them takes any more,
# and a quantifier on each blank would backtrack cubically on a long run of spaces.
QUESTION = re.compile(r"(?<![ \t]\?)(?:(?<![ \t])\?|\?(?![ \t][^\n?]*[ \t]:))(?!\?|\.?[A-Za-z0-9_]|:)")
# An optional type named in prose asks nothing either: "inferred String? because", "takes Int?, so". A capitalised
# word with a lowercase letter, its mark followed by a word that carries the statement on. At a line's end, or
# before any other word, it still reads as a question: "may I edit ListView? it is outside my paths" asks.
# A default or a return type follows one too (`Int? = nil`, `String? -> Bool`), and so does "or nil". "or" alone,
# "if" and a closing parenthesis do not: "Swift? or Kotlin", "ListView? if yes I start" and "(is it ListView?)" ask.
OPTIONAL = re.compile(r"(?<![@A-Za-z0-9_])[A-Z][A-Z0-9_]*[a-z][A-Za-z0-9_]*\?"
                      r"(?=[ \t]+(?:because|since|so|and|but|as|is|was|are|were|in|at|on|by|for|from|to|with|not|nil|null|none)(?![A-Za-z0-9_])"
                      r"|[ \t]+or[ \t]+(?:nil|null|none)(?![A-Za-z0-9_])|[ \t]*(?:[,;\]>=]|->))")


# A clause that opens like a question keeps its optional type's mark: "May I edit ListView? and its tests too" asks.
# Each name and separator run ends where its class does, so a failed word backtracks into nothing.
# Blanks are spaces and tabs, as in OPTIONAL and the pane's mirror.
INTERROGATIVE = re.compile(r"[ \t]*(?![ \t])(?:@[A-Za-z0-9_-]+(?![A-Za-z0-9_-])[ \t,:]*(?![ \t,:]))*"
                           r"(?:may|can|could|should|shall|will|would|do|does|did|is|are|was|were|has|have|had"
                           r"|which|what|who|whom|whose|where|when|why|how)(?![A-Za-z0-9_])", re.IGNORECASE | re.ASCII)
# A clause ends at a question mark or a line's end, and at `.`, `:`, `;` or `!` only before a blank or a line's end:
# the dot in src/config.ts ends nothing.
STOP = re.compile(r"[.:;!](?=[ \t\n])|[?\n]")
# A question quoted whole on one line is somebody else's, told as part of a report: `the verifier posts "@w does it
# parse CRLF?"` asks nothing. Seen live: a finding's scenario quoted one, and the coordinator paid a turn to say so.
# A brief that tells its reader to run a command. After "run" or "execute" any command counts: one in a code span, or a
# bare one with a flag (`Run ls -la first`). After a looser verb only a known program in a code span does: "Read
# `src/a.ts`" and "use `parseDate`" order nothing. Neither does "Do not run `x`".
SHELL_ORDER = re.compile(
    r"(?<!\bnot )(?<!\bnever )(?<!n't )\b(?:"
    r"(?:run|execute)[ \t]+(?:the[ \t]+)?(?:`([^`\n]+)`|([\w./-]+(?:[ \t]+[\w./-]+){0,2}[ \t]+--?[A-Za-z][\w-]*))"
    r"|(?:read|start with|use|call|check with)[ \t]+(?:the[ \t]+)?"
    r"`((?:git|python3?|bunx?|npm|npx|pnpm|yarn|pytest|make|cargo|go|xcodebuild|swift|sh|bash|zsh|\./)\b[^`\n]*)`)", re.I)
# A question quoted whole on one line is somebody else's, told as part of a report: `the verifier posts "@w does it
# parse CRLF?"` asks nothing. Seen live: a finding's scenario quoted one, and the coordinator paid a turn to say so.
SPOKEN = re.compile(r'"[^"\n]*"')


def asks(text):
    """Whether TEXT asks something. Quotes go first: an optional type inside a code span is already gone."""
    # Whole spans are taken in order, so a closing quote never opens the next one.
    text = SPOKEN.sub(lambda span: " " if "?" in span[0] else span[0], QUOTED.sub(" ", text))
    scanned, start = 0, 0

    def optional(m):
        # The clause starts after the last stop before the type. Each stretch is searched once, and a type's own mark
        # is a stop, so no clause is read twice: many types in a long text stay linear. The search ends at the type,
        # which opens with a letter, so a mark just before it is rightly no stop.
        nonlocal scanned, start
        for stop in STOP.finditer(text, scanned, m.start()):
            start = stop.end()
        scanned = m.start()
        return m[0] if INTERROGATIVE.match(text, start) else " "
    return QUESTION.search(OPTIONAL.sub(optional, text)) is not None


SUMMARY_CHARS = 200
ARG_COUNTS = {
    "init": (1, None), "restore": (1, 1), "adopt": (2, None), "locate": (2, None),
    "agent-run": (2, 3), "started": (3, 4), "member": (1, None),
    "limit": (0, None), "dispatch": (0, 0), "plan": (0, 0), "attention": (0, 1), "retry": (1, 1),
    "replace": (2, None), "post": (1, None), "ready": (1, 2), "revise": (1, None),
    "confirm": (2, 2), "read": (1, 4), "show": (0, 2), "wake": (0, 0),
    "claim": (3, 3), "woke": (3, 3), "rearm": (2, None), "bind": (1, 1),
    "pause": (0, None), "resume": (0, 1), "close": (0, 0), "kill": (0, None), "status": (0, 0), "account": (3, 4), "tail": (0, 1),
    "prune": (0, 2), "sync": (1, 2), "export": (0, 1),
}
READ_COMMANDS = {"show", "status", "plan", "attention", "wake", "export"}
USAGE = __doc__.split("\n\n")[1]


def atomic_write(path, value):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def save(d, state):
    allocate(state)
    atomic_write(os.path.join(d, "members.json"), json.dumps(state, indent=1))


def set_reviews(member, asked, members):
    """Set MEMBER's reviews= to ASKED, as `member` and `replace` take it: registered workers or all, on a verifier."""
    asked = list(dict.fromkeys(n.strip().lstrip("@").lower() for n in asked.split(",") if n.strip()))
    if asked and member.get("role") != "verifier":
        sys.exit("reviews= is a verifier's: it names the workers whose READY it reviews as each arrives")
    unknown = [n for n in asked if n != "all" and (n not in members or members[n].get("role") != "worker")]
    if unknown:
        sys.exit("reviews= takes registered workers, or all, and not " + ", ".join("@" + n for n in unknown))
    member["reviews"] = ",".join(asked)
    if not asked:
        member.pop("reviews")


def planned(d):
    """The `prepare` arguments the coordinator recorded with `verify.py ... prepare ... --when-ready`, or None."""
    try:
        with open(os.path.join(d, "verification-plan.json"), encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, ValueError):
        return None
    return plan if isinstance(plan, list) and plan and all(isinstance(arg, str) for arg in plan) else None


def load_state(d):
    with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
        state = json.load(f)
    members = state.get("members") if isinstance(state, dict) else None
    if not isinstance(members, dict) or COORDINATOR not in members or not isinstance(state.get("title"), str):
        raise ValueError("invalid swarm roster")
    return state


def is_post(post):
    if not (isinstance(post, dict) and type(post.get("seq")) is int
            and all(isinstance(post.get(key), str) for key in ("agent", "text", "time"))
            and ("to" not in post or (isinstance(post["to"], list) and all(isinstance(name, str) for name in post["to"])))):
        return False
    # Commits go on git's command line (`sync` merges them, the pane logs them): only full IDs. A post is kept without
    # the ones that are not, since they only say more about a report that stands without them.
    full = lambda commit: isinstance(commit, str) and COMMIT.fullmatch(commit) is not None
    for key in ("revision", "base"):
        if post.get(key) is not None and not full(post[key]):
            del post[key]
    if "except" in post and not ("base" in post and isinstance(post["except"], list) and post["except"]
                                 and all(full(commit) for commit in post["except"])):
        del post["except"]
    return True


def load(d, *, repair=True):
    state = load_state(d)
    path = os.path.join(d, "board.jsonl")
    posts = []
    try:
        f, writable = open(path, "rb+" if repair else "rb"), repair
    except OSError:  # a read-only copy can still be shown; it is simply not repaired
        f, writable = open(path, "rb"), False
    with f:
        while line := f.readline():
            if not line.strip():
                if not line.endswith(b"\n"):
                    if writable:
                        f.truncate(f.tell() - len(line))
                    break
                continue
            try:
                post = json.loads(line)
            except (ValueError, UnicodeError) as error:
                if line.endswith(b"\n"):
                    raise ValueError(f"invalid board record after post #{len(posts)}") from error
                # A killed writer may leave one incomplete record. Preserve all committed lines.
                if writable:
                    f.truncate(f.tell() - len(line))
                break
            if not is_post(post) or post["seq"] != len(posts) + 1:
                raise ValueError(f"invalid board record after post #{len(posts)}")
            posts.append(post)
            if not line.endswith(b"\n") and writable:
                f.write(b"\n")
    pending = state.pop("pending_post", None)
    if pending is not None:
        if not is_post(pending):  # appended as it is, it would make the whole journal unreadable
            raise ValueError("the pending board update in members.json is not a post")
        # A replacement commits its roster and brief together. Recover after either interrupted write.
        if pending["seq"] == len(posts) + 1:
            if writable:
                append_post(d, pending)
            posts.append(pending)
        elif not posts or posts[-1] != pending:
            raise ValueError("a pending board update conflicts with the saved history")
        if writable:  # a read-only copy shows the recovered post and repairs nothing
            save(d, state)
    for post in posts:
        if "to" not in post:
            post["to"] = [name for name in targets(post["text"], state["members"], sender=post["agent"]) if name != post["agent"]]
    return state, posts


def shown(path):
    """A path as a message names it: one with a control character or a byte that is no UTF-8 is quoted, so it can
    neither break the message nor forge a line of it."""
    name = os.fsdecode(path)
    return name if name.isprintable() else json.dumps(name)


def append_post(d, post):
    with open(os.path.join(d, "board.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(post) + "\n")
        f.flush()
        os.fsync(f.fileno())


def dependencies(member):
    return list(dict.fromkeys(member["depends"].split(","))) if member.get("depends") else []


def soft(member):
    """The dependencies MEMBER only comes after (after=): it waits for each to finish, with a report or without one."""
    return set(member["after"].split(",")) & set(dependencies(member)) if member.get("after") else set()


def unmet(member, members, ready, reported=None):
    """The dependencies MEMBER still waits for. One it needs (depends=) must be READY. One it only comes after (after=)
    is also done once its member was retired with no successor: a fan-in then goes on with the reports there are.
    REPORTED is the post number of MEMBER's own READY, when that is what is being judged: a report made before the
    retirement was built on the retired member's work, a rejected commit perhaps, and does not stand again.
    Ported from the `after` edges of Deuz-SDK's swarm scheduler (MIT, Copyright (c) 2026 Umutcan Edizaslan)."""
    after = soft(member)

    def gone(dep):
        retired = members.get(dep, {})
        return dep in after and retired.get("killed") and (reported is None or reported > retired.get("retired_at", 0))
    return [dep for dep in dependencies(member) if dep not in ready and not gone(dep)]


def withdrawn_commits(name, members, posts):
    """(the commits retired @NAME reported other than the one that counted as READY when it was retired, that one or
    None). The roster records it at retirement, from readiness as it then was: a report withdrawn by a NOT PASSED, a
    revise or a dependency that stopped counting did not stand."""
    stood = members.get(name, {}).get("stood")
    commits = [post["revision"] for post in posts
               if post.get("kind") == "ready" and post.get("subject", post["agent"]) == name and post.get("revision")]
    return [commit for commit in dict.fromkeys(commits) if commit != stood], stood


def is_ancestor(repo, older, newer, strict=False):
    """Whether commit OLDER is NEWER or in its history. With STRICT, Git failing to say is an error, not a no; a
    commit this repository no longer holds is in no history here."""
    import verify  # late: verify.py imports this module
    if not strict:
        return verify.git(repo, "merge-base", "--is-ancestor", older, newer, optional=True) is not None
    env = verify.clean_env()
    env["LC_ALL"] = "C"
    asked = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer], capture_output=True, env=env)
    if asked.returncode in (0, 1):
        return asked.returncode == 0
    # Exit 1 with nothing said is Git's "no such object"; anything else is Git failing to read, which is no answer.
    there = subprocess.run(["git", "-C", str(repo), "cat-file", "-e", older], capture_output=True, env=env)
    if there.returncode == 1 and not there.stderr.strip() \
            and verify.git(repo, "rev-parse", "-q", "--verify", newer + "^{commit}", optional=True) is not None:
        return False
    sys.exit("cannot tell whether %s holds the commit %s: %s" % (
        newer[:12], older[:12], asked.stderr.decode(errors="replace").strip() or "git failed"))


def upstream(member, members):
    """Every member MEMBER waits for, directly or through another."""
    seen, frontier = set(), dependencies(member)
    while frontier:
        dep = frontier.pop()
        if dep not in seen:
            seen.add(dep)
            frontier += dependencies(members.get(dep, {}))
    return seen


def withdrawn_in(repo, names, members, posts, revision, base=None):
    """(the retired member, its commit) for the first commit REVISION still holds that had not passed when one of
    NAMES, or a member whose place one of them took, was retired; None when there is none. A member put in a retired
    one's place takes its work over, so what the successor's latest READY holds is its own; what it left out is the
    retired member's still. What BASE already holds is the project's, not the candidate's. Git is asked only when such
    a member has in fact been retired, and a failure of Git's is an error: nothing is taken as clean unseen."""
    for dep in sorted(names):
        # The members whose place DEP holds, and DEP itself when it was retired with no successor.
        line = [name for name, entry in members.items() if entry.get("killed") and successor(name, members) == dep]
        if not line:
            continue
        taken = None if members.get(dep, {}).get("killed") else next((
            post["revision"] for post in reversed(posts)
            if post.get("kind") == "ready" and post.get("subject", post["agent"]) == dep and post.get("revision")), None)
        for name in line:
            left_behind, stood = withdrawn_commits(name, members, posts)
            for left in left_behind:
                # An earlier step of the work that stood, or of what the successor reports, is part of it.
                if is_ancestor(repo, left, revision, True) and not any(
                        kept and is_ancestor(repo, left, kept, True) for kept in (stood, taken, base)):
                    return name, left
    return None


def project_base(d, repo):
    """The project repository's HEAD commit ID when valid and present in REPO, else None."""
    import verify  # late: verify.py imports this module
    project = os.path.dirname(os.path.dirname(os.path.abspath(d)))
    head = verify.git(project, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
    if not head:
        return None
    commit = head.decode().strip()
    return commit if verify.git(repo, "cat-file", "-e", commit + "^{commit}", optional=True) is not None else None


def carried(repo, member, members, posts, revision, base=None):
    """What `withdrawn_in` finds in MEMBER's commit REVISION among the members it waits for, directly or through
    another. What a retired member left unpassed must not ride into the candidate on the commit of a member that came
    after it, however far down the chain: the report is waived by the retirement, the work is not."""
    return withdrawn_in(repo, upstream(member, members), members, posts, revision, base)


def merge_after(member, changes, before=""):
    """Fold an after= given in CHANGES into MEMBER's dependencies, and keep after= within them. A nonempty after= adds
    to BEFORE, what the member came after until now; an empty one clears it."""
    if changes.get("after"):
        member["after"] = ",".join(dict.fromkeys(filter(None, [*before.split(","), *changes["after"].split(",")])))
    if "after" in changes:
        member["depends"] = ",".join(dict.fromkeys([*dependencies(member), *filter(None, changes["after"].split(","))]))
        changes["depends"] = member["depends"]
    if member.get("after") is not None:
        member["after"] = ",".join(dep for dep in dict.fromkeys(member["after"].split(",")) if dep in dependencies(member))
        if not member["after"]:
            del member["after"]


def cyclic(members):
    """An active member that waits, through its dependencies, for itself; None when nobody does."""
    for start, member in members.items():
        frontier, seen = [] if member.get("killed") else dependencies(member), set()
        while frontier:
            dep = frontier.pop()
            if dep == start:
                return start
            if dep in members and dep not in seen:
                seen.add(dep)
                frontier += dependencies(members[dep])
    return None


def latest_reports(posts):
    latest = {}
    for post in posts:
        if post.get("kind") in {"finding", "ready", "revise"}:
            latest[post.get("subject", post["agent"])] = post
    return latest


def rejected(post, members):
    """The workers a verifier's NOT PASSED is about: those its first line names, or failing that every worker it reaches.
    A post records them when it is written, so a later change of groups or roles moves no verdict; older posts are
    worked out from the roster as it stands."""
    recorded = post.get("rejects")
    if isinstance(recorded, list) and all(isinstance(name, str) for name in recorded):
        return recorded
    word = REPORT_WORD.match(post["text"])
    if not word or word[1] != "NOT PASSED" or members.get(post["agent"], {}).get("role") != "verifier":
        return []
    reached = post.get("to", [])
    head = post["text"].split("\n", 1)[0]
    named = mentions(head)

    def rejectable(name, explicit=False):
        entry = members.get(name, {})
        if entry.get("role") != "worker" or entry.get("consult") == "1":
            return False
        return explicit or kind_of(entry) != "investigator"

    head_workers = [name for name in targets(head, members, include_killed=True, sender=post["agent"])
                    if name in reached and members.get(name, {}).get("role") == "worker"]
    first = [name for name in head_workers
             if rejectable(
                 name, explicit=(name in named or ("all" not in named and members.get(name, {}).get("group") in named)))]
    if head_workers:
        return first
    return [name for name in reached if rejectable(name)]


def readiness(members, posts):
    ready, refused = {}, {}
    for post in posts:
        for name in rejected(post, members):
            refused[name] = post["seq"]
    # Evaluate the latest reports in board order so prerequisites must still be current.
    for name, post in sorted(latest_reports(posts).items(), key=lambda entry: entry[1]["seq"]):
        member = members.get(name, {})
        # A NOT PASSED withdraws the report it answers: the fix is on the record only once the worker reports again.
        if (post["kind"] == "ready" and member.get("role") == "worker" and not member.get("killed")
                and refused.get(name, 0) < post["seq"]
                and not unmet(member, members, ready, post["seq"])):
            ready[name] = post
    return ready


# The model and effort each agent type runs at unless the roster says otherwise.
DEFAULTS = {"worker": ("sonnet", "medium"), "verifier": ("sonnet", "medium"), "explorer": ("haiku", "medium"),
            "investigator": ("opus", "medium"), "architect": ("fable", "high"), "designer": ("opus", "high")}
# Specialists read and report through the board tool. A designer is a profile that writes files, like a worker.
READ_ONLY = {"explorer", "investigator", "architect"}
PROFILES = {*READ_ONLY, "designer"}
FAMILIES = ("haiku", "sonnet", "opus", "fable")
LIMITS = {"max_workers", "max_members", "budget", "member_budget", *FAMILIES}
INHERITED = ("role", "group", "profile", "writes", "depends", "after", "owns", "paths", "model", "effort", "consult", "size", "reviews")
MEMBER_FIELDS = {*INHERITED, "backend", "id", "killed", "isolated", "budget"}
# The budget a run gets from its planned team, in charged tokens, until the user names one. A piece costs what its
# type usually spends, times the size the coordinator read from the task and the effort it runs at.
# Measured: a worker's piece 0.4-1.1M, a verifier 0.3-1.3M, the coordinator about 0.3M in a fresh conversation, an
# investigator about 0.45M by the 200k context ceiling. The architect, the explorer and the factors are estimates:
# tune them against the Usage table of exported runs.
ALLOWANCE = {"worker": 700_000, "designer": 700_000, "verifier": 600_000, "investigator": 500_000, "architect": 400_000,
             "explorer": 150_000}
SIZES = {"s": 0.5, "m": 1, "l": 2}
EFFORT_COST = {"low": 0.7, "medium": 1, "high": 1.5, "xhigh": 2, "max": 2.5}
COORDINATOR_BASE, COORDINATOR_PER_MEMBER = 300_000, 40_000
RESERVE = 0.2      # of the members' shares, for rework and replacements
MEMBER_CAP = 1.5   # a member is stopped alone at this multiple of its share: a runaway, not a tight piece
AUTO_MAX = 8_000_000  # a plan that needs more is the user's decision: limit budget=<tokens>
RESERVED = {"all", "verifiers", "dependents"}  # mentions that reach several members, so no member or group takes them


def assignments(args, allowed):
    changes = {}
    for arg in args:
        key, sep, value = arg.partition("=")
        if not sep or key not in allowed or key in changes:
            raise ValueError(f"invalid or repeated option {arg!r}; expected one of {', '.join(sorted(allowed))}")
        changes[key] = value
    # Older callers sometimes named the worker or verifier through profile instead of role.
    role = changes.get("profile")
    if role in {"worker", "verifier"}:
        if changes.get("role", role) != role:
            raise ValueError("role conflicts with the selected profile")
        changes.update(role=role, profile="")
    return changes


def claims(member):
    """The files and folders a member claims with paths=, as paths from the project folder."""
    return [path for path in (member.get("paths") or "").split(",") if path]


def assignment_scope(member):
    return (kind_of(member), member.get("writes") != "0", member.get("consult") == "1",
            member.get("owns", ""), set(claims(member)), set(dependencies(member)))


def claimed_twice(name, member, members):
    """The first path two active writers both claim, with the other member's name, or None."""
    def writes(entry):
        return (entry.get("role") == "worker" and not entry.get("killed") and entry.get("writes") != "0"
                and entry.get("consult") != "1" and kind_of(entry) not in READ_ONLY)
    if not writes(member):
        return None
    for other, entry in members.items():
        if other == name or not writes(entry):
            continue
        for mine in claims(member):
            for theirs in claims(entry):
                # A folder claims everything under it.
                low, other_low = mine.casefold(), theirs.casefold()
                if low == other_low or low.startswith(other_low + "/") or other_low.startswith(low + "/"):
                    return other, mine if len(mine) >= len(theirs) else theirs
    return None


def validate_member(name, member, changes, members):
    if "paths" in changes:
        cleaned = []
        for raw in changes["paths"].split(","):
            token = raw.strip()
            if not token:
                continue
            if token.startswith("/") or any(c in token for c in ("\n", "\r", "\0", "\\")):
                raise ValueError("paths= takes files and folders relative to the project folder, separated by commas")
            parts = [seg for seg in token.split("/") if seg not in ("", ".")]
            if ".." in parts:
                raise ValueError("paths= takes files and folders relative to the project folder, separated by commas")
            if not parts:
                raise ValueError("paths= must name specific files or folders relative to the project folder, not '.'")
            cleaned.append("/".join(parts))
        member["paths"] = ",".join(dict.fromkeys(cleaned))
    if "role" in changes and member["role"] not in ({COORDINATOR} if name == COORDINATOR else {"worker", "verifier"}):
        raise ValueError(f"invalid role for @{name}")
    if member.get("role") == "verifier" and member.get("depends") and {"role", "depends"} & changes.keys():
        raise ValueError("a verifier is told when every worker is ready and waits for no member: depends= is for workers. "
                         "Clear it with depends=")
    if ("profile" in changes and member["profile"] not in {"", *PROFILES}) or (
            {"role", "profile"} & changes.keys() and member.get("profile") and member["role"] != "worker"):
        raise ValueError("specialist and designer profiles belong to workers")
    if name == COORDINATOR and changes.keys() - {"backend", "role", "id", "killed", "depends"}:
        raise ValueError("the coordinator is the conversation itself: only backend= can be set on it")
    if changes.get("group") not in (None, "", "-") and (
            not NAME.fullmatch(changes["group"]) or changes["group"] in RESERVED
            or changes["group"] == name or changes["group"] in members):
        raise ValueError("a group name uses lowercase letters, digits, underscores and hyphens, and is neither %s nor a "
                         "member's name" % ", ".join(sorted(RESERVED)))
    if "budget" in changes:  # 0 or - clears it, as budget=0 clears the run's
        if changes["budget"] in {"", "-"} or (re.fullmatch(r"[0-9]{1,15}", changes["budget"]) and not int(changes["budget"])):
            member.pop("budget", None)
        elif not re.fullmatch(r"[0-9]{1,15}", changes["budget"]):
            raise ValueError("budget= takes a token count; 0 or - clears it")
    if "model" in changes and changes["model"] not in {"", "inherit", *FAMILIES} and (
            any(c.isspace() for c in changes["model"]) or not any(f in changes["model"].lower() for f in FAMILIES)):
        raise ValueError("model must be inherit, a model family (%s), or a model ID containing one" % ", ".join(FAMILIES))
    if "backend" in changes and (name != COORDINATOR or changes["backend"] not in {"", "native"}):
        raise ValueError("backend=native is only valid for the coordinator")
    if name == COORDINATOR and {"id", "killed", "depends"} & changes.keys():
        raise ValueError("the coordinator cannot be assigned an agent address, retired, or made dependent")
    if "killed" in changes and changes["killed"] != "1":
        raise ValueError("use killed=1 to retire a member, or replace to register a successor")
    for flag in ("writes", "consult", "isolated"):
        if flag in changes and changes[flag] not in {"", "0", "1"}:
            raise ValueError(f"{flag} must be 0 or 1")
    if "size" in changes and changes["size"] not in {"", *SIZES}:
        raise ValueError("size is s, m or l: how large this member's piece of the task is")
    if "effort" in changes and changes["effort"] not in {"", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError("effort must be low, medium, high, xhigh, or max")
    if "effort" in changes:  # named now, whatever it started on
        member.pop("sized", None)
    if member.get("profile") in READ_ONLY:
        if "profile" in changes and "writes" not in changes:
            member["writes"] = "0"
        if "writes" in changes and member.get("writes") != "0":
            raise ValueError("specialist profiles are read-only")
    if member.get("consult") == "1" and (kind_of(member) != "architect" or member.get("writes") != "0"):
        raise ValueError("consult=1 is only valid for a read-only architect")
    if "id" in changes and (not changes["id"] or any(c.isspace() for c in changes["id"]) or any(
            other != name and entry.get("id") == changes["id"] for other, entry in members.items())):
        raise ValueError("agent addresses must be nonempty and unique within the run, including retired members")
    clash = claimed_twice(name, member, members)
    if clash:
        raise ValueError("@%s and @%s both claim %s. No path has two writers: give it to one of them and have the other "
                         "depend on that member or post what it needs changed there" % (name, clash[0], clash[1]))


def usable_name(name, members):
    """A new member's name: one a mention can carry, that no group already answers to."""
    return bool(NAME.fullmatch(name)) and name not in RESERVED and all(entry.get("group") != name for entry in members.values())


def stranded(name, members):
    """Refuse a member that is no worker or is a consultant while others wait for it: readiness() and
    retiring consultants would leave dependents stuck."""
    waiting = [n for n, entry in team_of(members).items() if name in dependencies(entry)]
    if waiting and (members[name].get("role") != "worker" or members[name].get("consult") == "1"):
        sys.exit("@%s stays a non-consultant worker while %s wait(s) for it; change their depends= first. Nothing was changed"
                 % (name, ", ".join("@" + n for n in waiting)))


def kind_of(member):
    """The agent type behind a member: its profile (a specialist or the designer), else its role."""
    return member.get("profile") or member.get("role", "worker")


def model_of(member):
    return member.get("model") or DEFAULTS.get(kind_of(member), ("", ""))[0]


# The effort a piece runs at when none is named follows its size: a small piece one step under its type's default, a
# large one a step over, never past high. An estimate, like the sizes: tune it against the Usage table.
EFFORT_STEPS = ("low", "medium", "high")


def sized_effort(kind, size):
    base = DEFAULTS.get(kind, ("", ""))[1]
    if base not in EFFORT_STEPS or size not in ("s", "l"):
        return base
    return EFFORT_STEPS[max(0, min(len(EFFORT_STEPS) - 1, EFFORT_STEPS.index(base) + (1 if size == "l" else -1)))]


def effort_of(member):
    return member.get("effort") or sized_effort(kind_of(member), member.get("size"))


def started_as(member):
    """Records what MEMBER starts on. A default changed later, or a size, then moves no member already running, and a
    report of the run says what it really ran on."""
    if not member.get("effort"):  # taken from its size, which the allocation has already counted
        member["effort"], member["sized"] = effort_of(member), "1"
    if not member.get("model"):
        member["model"] = family(model_of(member))


def family(model):
    return next((name for name in FAMILIES if name in model.lower()), model)


def team_of(members):
    return {n: m for n, m in members.items() if n != COORDINATOR and not m.get("killed")}


def roster_counts(state):
    team = team_of(state["members"])
    workers = sum(1 for m in team.values() if m.get("role") != "verifier")
    return workers, len(team)


def family_limit_errors(state):
    limits, team = state.get("limits", {}), team_of(state["members"])
    errors = []
    for name in FAMILIES:
        if name in limits:
            allowed = set(limits[name].split(",")) - {"none", ""}
            for member, entry in team.items():
                if family(model_of(entry)) == name and kind_of(entry) not in allowed and member not in allowed:
                    errors.append("@%s (%s) would run on %s, which this run allows only for: %s. Register it with another model="
                                  % (member, kind_of(entry), name, ", ".join(sorted(allowed)) or "nobody"))
    return errors


def limit_errors(state):
    """Every way the roster breaks the run's limits, as sentences the coordinator can act on."""
    limits = state.get("limits", {})
    workers, team_count = roster_counts(state)
    errors = []
    if "max_workers" in limits and workers > int(limits["max_workers"]):
        errors.append("%d workers, but this run allows %s" % (workers, limits["max_workers"]))
    if "max_members" in limits and team_count > int(limits["max_members"]):
        errors.append("%d members, but this run allows %s" % (team_count, limits["max_members"]))
    return errors + family_limit_errors(state)


def added_limit_errors(state, before_counts, before_family):
    limits = state.get("limits", {})
    before_workers, before_team = before_counts
    after_workers, after_team = roster_counts(state)
    errors = []
    if "max_workers" in limits and after_workers > int(limits["max_workers"]) and after_workers > before_workers:
        errors.append("%d workers, but this run allows %s" % (after_workers, limits["max_workers"]))
    if "max_members" in limits and after_team > int(limits["max_members"]) and after_team > before_team:
        errors.append("%d members, but this run allows %s" % (after_team, limits["max_members"]))
    return errors + [error for error in family_limit_errors(state) if error not in before_family]


def unread_of(name, members, posts):
    return [p["seq"] for p in posts if p["seq"] > members[name]["last_read_seq"] and name in p["to"]]


def unwoken_of(name, members, posts):
    return [n for n in unread_of(name, members, posts) if n > members[name].get("last_nudged_seq", 0)]


def unreachable(name, members, posts):
    owed, claim = unwoken_of(name, members, posts), members[name].get("wake_claim", {})
    # The last attempt has its lease to succeed in before the member counts as unreachable.
    # Failed attempts belong to the member, so a mention newer than the claim does not hide them.
    return bool(owed) and claim.get("attempts", 0) >= WAKE_ATTEMPTS and claim.get("until", 0) <= time.time()


def ignored(name, members, posts):
    """Woken WAKE_ATTEMPTS times in a row and still has not read its mentions."""
    return bool(unread_of(name, members, posts)) and members[name].get("told", {}).get("times", 0) >= WAKE_ATTEMPTS


def verified_line(d, verifier, first):
    """The current candidate when FIRST carries the line verify.py printed for it, passed by this verifier; else False."""
    try:
        with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
            candidate = json.load(f)
    except (FileNotFoundError, ValueError):
        return False
    if not isinstance(candidate, dict):
        return False
    line = "VERIFIED %s %s" % (candidate.get("candidate"), candidate.get("commit") or candidate.get("digest"))
    if candidate.get("verified_by") != verifier or re.search(r"(?<!\w)%s(?!\w)" % re.escape(line), first) is None:
        return False
    stale = stale_pass(d, candidate)
    if stale:
        sys.exit("that VERIFIED is void: %s. Post NOT VERIFIED or a note, and wait for a new candidate." % stale)
    return candidate


def stale_pass(d, candidate, closed=False):
    """Why CANDIDATE's pass no longer holds, or None while it does. A pass describes the sources and reports it ran on:
    a change since then voids it, accepted or not. A closed run keeps the answer `close` recorded."""
    if closed:
        return candidate.get("stale")
    import verify  # late: verify.py imports this module
    try:
        verify.check_current(verify.Path(d), candidate)
    except (ValueError, OSError, KeyError, TypeError) as error:
        return str(error) or type(error).__name__
    return None


def held(candidate, members):
    """The workers whose work CANDIDATE holds: those whose reports it records, and every worker they depend on, since a
    dependent's commit contains its dependency's and its readiness falls with it."""
    names, frontier = set(), list(candidate.get("inputs") or {})
    while frontier:
        name = frontier.pop()
        if name not in names:
            names.add(name)
            frontier += dependencies(members.get(name, {}))
    return names


def void_pass(d, members, rejected_names=()):
    """A verifier's rejection withdraws the pass of the candidate on the table: only a fresh test restores it. A NOT
    PASSED naming only workers a partial candidate does not hold leaves that candidate's pass alone."""
    path = os.path.join(d, "verification.json")
    try:
        with open(path, encoding="utf-8") as f:
            candidate = json.load(f)
    except (FileNotFoundError, ValueError):
        return
    if (isinstance(candidate, dict) and candidate.get("partial") and rejected_names
            and not set(rejected_names) & held(candidate, members)):
        return
    if isinstance(candidate, dict) and not candidate.get("accepted") and ("verified_by" in candidate or "attempt" in candidate):
        candidate.pop("verified_by", None)
        candidate.pop("attempt", None)
        atomic_write(path, json.dumps(candidate, indent=2))


# What makes a post that names a candidate a request to its verifier: "test", "run it again", "re-check", "review".
REQUEST = re.compile(r"\b(?:re-?)?(?:test|verify|review|run|check)\b", re.I)


def answered(d, sender, first, members, posts):
    """The candidate VERIFIER SENDER's verdict answers, as (its id, the reports it held, why, the id on the table,
    sure): the one FIRST (the verdict's first line) names; else the one the verifier is testing and has given no
    verdict on, as verify.py records it; else the one the newest request it has read names, which is not sure; else
    the one on the table. A verdict written while a replacement was prepared answers the candidate it was about, not
    whatever is on the table by the time it is posted. All None when no candidate is being verified."""
    try:
        with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
            candidate = json.load(f)
    except (FileNotFoundError, ValueError):
        candidate = None
    if not isinstance(candidate, dict) or not isinstance(candidate.get("candidate"), str):
        return None, None, None, None, False
    # An accepted candidate is past any verdict: only the ones it replaced can still be answered, and such a verdict
    # holds no report (None), so it withdraws nothing the accepted one was made of.
    accepted = bool(candidate.get("accepted"))
    current = None if accepted else candidate["candidate"]
    known = {entry["candidate"]: None if accepted else entry.get("inputs") for entry in candidate.get("superseded") or []
             if isinstance(entry, dict) and isinstance(entry.get("candidate"), str)}
    if not accepted:
        known[current] = candidate.get("inputs")

    def named(text):  # the newest known candidate TEXT names, the one on the table first
        found = [name for name in known if re.search(r"(?<![0-9A-Za-z])%s(?![0-9A-Za-z])" % re.escape(name), text)]
        return current if current in found else found[-1] if found else None

    def requested(text):  # only a request to test it: a post that merely mentions a candidate asks for nothing
        return named(text) if REQUEST.search(text) else None

    reader = members.get(sender, {})
    asked = next((hit for p in reversed(posts) if p["seq"] <= reader.get("last_read_seq", 0) and p["agent"] != sender
                  and sender in p["to"] and (hit := requested(p["text"]))), None)
    for answer, why, sure in ((named(first), "which its first line names", True),
                              (reader.get("tested") if reader.get("tested") in known else None, "the one you tested last", True),
                              (asked, "the one the latest request you read names", False), (current, "", True)):
        if answer:
            held = known[answer]
            return answer, held if isinstance(held, dict) else None, why, current, sure
    return None, None, None, None, False


def in_play(d, name, members):
    """True when the candidate being tested or waiting to be accepted holds NAME's work: a change to that report
    kills the candidate, so its verifier has to hear."""
    try:
        with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
            candidate = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(candidate, dict) and not candidate.get("accepted") and name in held(candidate, members)


def fork_point(repo, ref):
    """The commit branch REF started from, as the "branch: Created from" entry of its reflog records it, or None."""
    import verify  # late: verify.py imports this module
    log = verify.git(repo, "reflog", "show", "--format=%H %gs", ref, "--", optional=True) or b""
    created = [commit.decode() for commit, _, subject in (line.partition(b" ") for line in log.splitlines())
               if subject.startswith(b"branch: Created from")]
    return created[-1] if created and COMMIT.fullmatch(created[-1]) else None


def checkout_start(here):
    """Where the checkout at HERE began: where its branch started, or, detached in a linked worktree, the commit the
    worktree was made at, the oldest entry of its own HEAD reflog. None when neither is known."""
    import verify  # late: verify.py imports this module
    branch = verify.git(here, "symbolic-ref", "-q", "HEAD", optional=True)
    if branch:
        return fork_point(here, branch.decode().strip())
    dirs = verify.git(here, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", optional=True)
    if not dirs or len(set(dirs.splitlines())) < 2:  # the main checkout's HEAD reflog goes back to the first commit
        return None
    log = (verify.git(here, "reflog", "show", "--format=%H", "HEAD", "--", optional=True) or b"").split()
    return log[-1].decode() if log and COMMIT.fullmatch(log[-1].decode()) else None


def branch_starts(repo, revision):
    """Where each branch whose tip is REVISION started."""
    import verify  # late: verify.py imports this module
    refs = verify.git(repo, "for-each-ref", "--format=%(refname)", "--points-at", revision, "refs/heads/", optional=True) or b""
    return [start for ref in refs.decode(errors="replace").splitlines() if (start := fork_point(repo, ref))]


def fresh(repo, start, earlier):
    """START, unless it holds one of EARLIER, the member's own commits reported before: a branch made from its own work
    (a fix begun on a new branch after a rejection) began inside that work, not before it."""
    if not start or not COMMIT.fullmatch(start):
        return None
    return None if any(is_ancestor(repo, commit, start) for commit in dict.fromkeys(earlier)) else start


def earlier_commits(name, posts):
    """The commits NAME has reported READY with."""
    return [post["revision"] for post in posts if post.get("kind") == "ready" and post.get("revision")
            and post.get("subject", post["agent"]) == name]


def own_range(repo, revision, starts, merged, earlier=()):
    """BASE and EXCEPT of a READY for REVISION: the member's own work is `git log --first-parent --no-merges REVISION
    --not BASE EXCEPT...`. BASE is whichever of the project's HEAD and the commits the member's branch started from
    (STARTS, less any that holds one of EARLIER, its own reported commits) meets REVISION highest; EXCEPT is each other one that still hides something, and each of MERGED (its
    dependencies' commits) REVISION holds and BASE does not: one brought in by a fast-forward or by hand sits on the
    first-parent line. (None, []) when HEAD already holds REVISION and no start is known, which leaves nothing to show."""
    import verify  # late: verify.py imports this module

    def ancestor(older, newer):
        return is_ancestor(repo, older, newer)

    cuts = {}  # each candidate base, with the commit it meets REVISION at
    head = verify.git(repo, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
    head = head.decode().strip() if head else None
    if head and not ancestor(revision, head):  # a HEAD that holds the commit hides all of it
        met = verify.git(repo, "merge-base", head, revision, optional=True)
        if met:
            cuts[head] = met.decode().split()[0]
    for start in dict.fromkeys(starts):  # a start equal to REVISION would hide the whole report: it is no start of this work
        if start and start not in cuts and start != revision and ancestor(start, revision) and fresh(repo, start, earlier):
            cuts[start] = start
    base = None
    for commit, cut in cuts.items():  # HEAD first: it stays the base unless a start meets the commit above it
        if base is None or (cut != cuts[base] and ancestor(cuts[base], cut)):
            base = commit
    if base is None:
        return None, []
    rest = [commit for commit, cut in cuts.items() if commit != base and not ancestor(cut, base)]
    for commit in dict.fromkeys(merged):
        if (commit and COMMIT.fullmatch(commit) and commit not in rest and commit not in (base, revision)
                and ancestor(commit, revision) and not ancestor(commit, base)):
            rest.append(commit)
    return base, rest


def successor(name, members):
    seen = set()
    while name in members and members[name].get("killed") and members[name].get("replaced_by") and name not in seen:
        seen.add(name)
        name = members[name]["replaced_by"]
    return name


def unanswered(members, posts):
    """Track pending questions per asker and recipient in board order."""
    pending = {}
    for post in posts:
        text = post["text"]
        report = post.get("kind") or REPORT_WORD.match(text)
        asking = not report and asks(text)
        text = QUOTED.sub(" ", text)  # `re #99` in a code span cites nothing
        sender = post["agent"]
        responder = successor(sender, members)
        # "re #4" or "re: #4", and every number of "re #4, #7 and #9" or "re #4 #7 #9"
        cited = [seq for run in re.findall(r"\bre(?:\s+|\s*:\s*)((?:#[0-9]+(?:\s*(?:,|and|&)?\s*))+)", text, re.IGNORECASE)
                 for seq in re.findall(r"#([0-9]+)", run)]
        # A bare "#7" cites too, but only a question put to the poster: "@regions Thanks #7" answers it.
        named = [] if report or cited else re.findall(r"(?<![A-Za-z0-9_&])#([0-9]+)", text)
        # Only a citation settles: a post that cites nothing may be about anything, and the asker still waits. It
        # settles by the question's number, whoever the post reaches, so a bare `re #7` closes it and wakes nobody.
        # The asker withdraws its own question the same way, and the coordinator's ruling settles it for everyone it
        # was put to: a member asked in the same post owes no second answer.
        for key, seqs in pending.items():
            for seq in (cited + named if key[1] == responder else cited if sender in (key[0], COORDINATOR) else []):
                seqs.pop(seq.lstrip("0"), None)
        for recipient in post["to"]:
            target = successor(recipient, members)
            if asking and target in members and not members[target].get("killed"):
                pending.setdefault((sender, target), {})[str(post["seq"])] = post["seq"]
    # A removed member is waiting for nothing: its questions close with it.
    return sorted((seq, asker, recipient) for (asker, recipient), seqs in pending.items() for seq in seqs.values()
                  if not members.get(asker, {}).get("killed"))


def runnable(name, members, posts, ready):
    """Whether NAME can act now, so starting its agent costs no idle wait: a worker once its dependencies are READY,
    a verifier once every non-consultant worker is, once a worker its reviews= names is, or once a post after its
    brief asks it for an early review."""
    member = members[name]
    if member.get("role") != "verifier":
        return not unmet(member, members, ready)
    if all(n in ready for n, e in team_of(members).items() if e.get("role") == "worker" and e.get("consult") != "1"):
        return True
    # With reviews= it reviews each named worker's READY as it arrives: one of them standing is work for it.
    watched = set(filter(None, member.get("reviews", "").split(",")))
    if any(n in ready and members[n].get("role") == "worker" for n in (ready if "all" in watched else watched)):
        return True

    def brief(p):
        return (w := REPORT_WORD.match(p["text"])) is not None and w[1] == "BRIEF"

    # A second brief asks for no review. A READY or REVISE reaches a verifier on its own, and while a worker is
    # unready never does, even when it names one. @all and a group are news it reads on its first turn anyway:
    # only its name or @verifiers asks it to start.
    briefs = [p["seq"] for p in posts if name in p["to"] and brief(p)]
    # The request is the coordinator's: a member that names the verifier in an interim note starts no review of half
    # the work. Seen live: one such mention cost a verifier a round of interim verdicts, one of them wrong.
    return bool(briefs) and any(p["seq"] > briefs[0] and name in p["to"] and not p.get("kind") and not brief(p)
                                and p["agent"] == COORDINATOR and mentions(p["text"]) & {name, "verifiers"} for p in posts)


def rework(state, posts):
    """The NOT PASSED posts each worker has received in a row, one for each candidate it failed in: a second
    verdict on the same candidate, such as test results added to a source review, is the same failure. A verifier's
    VERIFIED covers every worker and starts the count again, as does an accepted candidate."""
    members, failed, latest = state["members"], {}, {}
    for post in posts:
        if post.get("kind") == "ready":
            # New work: a verdict on it is a new failure, whatever candidate is on the table. A confirmed finding is
            # posted by the coordinator about its investigator.
            latest.pop(post.get("subject", post["agent"]), None)
        word = REPORT_WORD.match(post["text"])
        # What the post records makes it a verifier's, whatever its author's role is now; an older post records
        # nothing, and goes by the role.
        if post["seq"] <= state.get("accepted_seq", 0) or not word or not (
                "rejects" in post or post.get("rules") or members.get(post["agent"], {}).get("role") == "verifier"):
            continue
        if word[1] == "VERIFIED" and post.get("partial"):  # a partial pass clears only the workers it held
            for name in post.get("members", []):
                failed.pop(name, None)
                latest.pop(name, None)
        elif word[1] == "VERIFIED":
            failed, latest = {}, {}
        elif word[1] == "NOT PASSED":
            for name in rejected(post, members):
                # A verdict made with no candidate on the table is counted on its own.
                if post.get("candidate") is None or latest.get(name) != post["candidate"]:
                    failed.setdefault(name, []).append(post["seq"])
                latest[name] = post.get("candidate")
    return failed


# The finding ledger. Every defect a verifier's NOT PASSED raises gets an id from the board, the worker answers each id
# in its next READY, and only the verifier closes one. Ported from OpenSwarm's findingLedger.ts (MIT, Copyright (c) 2026
# Heewon Oh) onto the board's record: the ledger is worked out from the posts and never stored, so a replay changes
# nothing. Ids come from the board, never from a model: a verifier rewords a defect from round to round, so neither a
# label of its own nor a hash of the text would stay stable.
FINDING_ID = r"(?<![\w-])(F\d+)\b"
BULLET = re.compile(r"(?:[-*]|\d+[.)])[ \t]+")  # at the start of a line only: an indented item is detail of the one above
# `F<n>:` or `[F<n>]` only: "F1 score is low" is prose, no tag.
ID_TAG = re.compile(r"\s*(?:\[%s\]\s*(?:[:\-—–]\s*)?|%s\s*:\s*)" % (FINDING_ID, FINDING_ID), re.I | re.A)
CLOSE_WORDS, OPEN_WORDS = "resolved|closed|verified", "still open|open|unresolved|not fixed"
# A line that is essentially `F<n>: <ruling>`, bulleted or not. After the ruling word comes nothing, or ` — reason`,
# ` - reason` or `: reason`: "verified the bug still reproduces" and "closed-form estimate" are prose, no rulings.
RULING_LINE = re.compile(
    r"^[ \t]*(?:[-*][ \t]*)?(?:\[%s\][ \t]*[:\-—–]?|%s[ \t]*[:\-—–])[ \t]*(%s|%s)[.!]?(?:[ \t]*(?:—|–|:)[ \t]*\S.*|[ \t]+-[ \t]+\S.*)?[ \t]*$"
    % (FINDING_ID, FINDING_ID, CLOSE_WORDS, OPEN_WORDS), re.I | re.M | re.A)
# An `open` ruling anywhere in the text. Loose on purpose: it can only keep an id open, never close one.
LOOSE_OPEN = re.compile(r"%s\]?[ \t]*[:\-—–][ \t]*(?:%s)\b" % (FINDING_ID, OPEN_WORDS), re.I | re.A)
# One answer: `F<n>: fixed|disputed — evidence`. The evidence runs to the end of the line or to the next answer.
RESPONSE_LINE = re.compile(
    r"\[?%s\]?[ \t]*[:\-—–][ \t]*(fixed|disputed)\b[ \t]*(?:[:\-—–][ \t]*)?([^\n]*?)"
    r"(?=[ \t]+(?:[-*][ \t]*)?\[?F\d+\]?[ \t]*[:\-—–][ \t]*(?:fixed|disputed)\b|[ \t]*$)" % FINDING_ID, re.I | re.M | re.A)
DISPUTE_PAUSE = 1  # reviews in a row that keep open what the worker disputed, before the run is paused


def fenced(lines):
    """The indexes of LINES inside a fenced code block, the fence lines included: a pasted log or traceback there is
    quoted output, and no line of it raises, answers or rules on a finding."""
    opened, found = None, set()
    for index, line in enumerate(lines):
        mark = re.match(r" {0,3}(`{3,}|~{3,})(.*)", line)
        if opened is None:
            if not mark or (mark[1][0] == "`" and "`" in mark[2]):
                continue
            opened = mark[1]
            found.add(index)
            continue
        found.add(index)
        # Only a fence of the opener's own mark, at least as long and with nothing after it, closes the block: a
        # shorter one inside a longer is part of what is quoted.
        if mark and mark[1][0] == opened[0] and len(mark[1]) >= len(opened) and not mark[2].strip():
            opened = None
    return found


def quoted_code(lines):
    return fenced(lines) | {index for index, line in enumerate(lines) if re.match(r"^(?: {4}| {0,3}\t)", line)}


def unfenced(text, *, include_indented=False):
    lines = text.split("\n")
    quoted = quoted_code(lines) if include_indented else fenced(lines)
    return "\n".join("" if index in quoted else line for index, line in enumerate(lines))


def rulings_in(text):
    """{id: "resolved" or "open"} as a verifier's text rules. `F2: resolved` (or closed, verified) closes, only as a whole
    line; `F2: open`, `still open` or `not fixed` keeps open, read anywhere. "fixed" closes nothing: it is the worker's
    word, and a verifier quoting the worker must not close an id. Where an id carries both, open wins."""
    rulings, text = {}, unfenced(text, include_indented=True)
    for match in RULING_LINE.finditer(text):
        name = (match[1] or match[2]).upper()
        if rulings.get(name) != "open":
            rulings[name] = "resolved" if match[3].lower() in CLOSE_WORDS.split("|") else "open"
    for match in LOOSE_OPEN.finditer(text):
        rulings[match[1].upper()] = "open"
    return rulings


def answers_in(text, known):
    """{id: (fixed or disputed, the evidence)} for the ids in KNOWN that a worker's report answers. An answer with no
    evidence is none, and neither are two different answers to one id, since neither can be trusted."""
    seen, conflicted = {}, set()
    for match in RESPONSE_LINE.finditer(unfenced(text, include_indented=True)):
        name, evidence = match[1].upper(), match[3].strip()
        if name not in known:
            continue
        answer = (match[2].lower(), evidence) if evidence else None
        if name in seen and seen[name] != answer:
            conflicted.add(name)
        seen[name] = answer
    return {name: answer for name, answer in seen.items() if answer and name not in conflicted}


def tagged(text):
    """[(the id a NOT PASSED puts on a defect, the defect's text)]: an id on a bullet, or one in brackets right after
    the verdict word for a verdict that is one defect in prose."""
    lines, found = unfenced(text, include_indented=True).split("\n"), []
    for line in lines:
        mark = BULLET.match(line)
        tag = mark and not RULING_LINE.fullmatch(line) and ID_TAG.match(line, mark.end())
        if tag:
            found.append(((tag[1] or tag[2]).upper(), line[tag.end():].strip()))
    word = REPORT_WORD.match(lines[0])
    whole = word and re.match(r"[ \t]*\[(F\d+)\]", lines[0][word.end():], re.I | re.A)
    if whole:
        summary = re.sub(r"^(?:[ \t.:,;—–-]|@[A-Za-z0-9][A-Za-z0-9_-]*)+", "", lines[0][word.end() + whole.end():]).strip()
        if not summary:
            summary = next((line.strip() for line in lines[1:] if line.strip() and not RULING_LINE.fullmatch(line)), "")
        found.append((whole[1].upper(), summary))
    return found


def tag_findings(text, known, number, members=None):
    """(TEXT with an id on each defect a NOT PASSED raises, the ids given), counting on from NUMBER. A defect is a
    bullet at the start of a line; a verdict with none is one defect in prose, unless it only rules on ids in KNOWN.
    A bullet that carries a known id raises that defect again, and an id the board never gave is replaced."""
    lines, given = text.split("\n"), []

    def fresh():
        given.append("F%d" % (number + len(given)))
        return given[-1]
    bullets, quoted = False, quoted_code(lines)
    for index, line in enumerate(lines):
        mark = BULLET.match(line)
        if not mark or index in quoted:
            continue
        if RULING_LINE.fullmatch(line):
            continue
        bullets = True
        tag = ID_TAG.match(line, mark.end())
        if tag and (tag[1] or tag[2]).upper() in known:
            continue
        lines[index] = "%s%s: %s" % (line[:mark.end()], fresh(), line[tag.end() if tag else mark.end():])
    word = REPORT_WORD.match(lines[0])
    if not bullets and word:
        rest = lines[0][word.end():]
        whole = re.match(r"[ \t]*\[(F\d+)\]", rest, re.I | re.A)
        about = {name.upper() for name in re.findall(FINDING_ID + r"\]?[ \t]*[:\-—–\]]", unfenced(text, include_indented=True), re.I | re.A)} & known
        if whole and whole[1].upper() not in known:
            rest = rest[whole.end():]  # an id the board never gave
        # A verdict that only closes known ids says what is wrong in its prose: that is a new defect.
        rulings = rulings_in(text)
        routing = RESERVED | (
            set(members) | {entry["group"] for entry in members.values() if entry.get("group")}
            if members else set()
        )
        def strip_routing(line):
            return MENTION.sub(
                lambda m: "" if m[1].lower() in routing or m[1].lower().rstrip("-_") in routing else m[0],
                line,
            ).strip(" \t.:,;—–-")

        has_prose = bool(strip_routing(rest)) or any(
            index not in quoted and not RULING_LINE.fullmatch(line) and bool(strip_routing(line))
            for index, line in enumerate(lines[1:], start=1)
        )
        if has_prose and not any(rulings.get(name) != "resolved" for name in about):
            lines[0] = "%s [%s]%s" % (lines[0][:word.end()], fresh(), rest)
    return "\n".join(lines), given


def ledger(state, posts):
    """{id: finding} for every defect raised since the last accepted candidate, in the order raised. A finding holds
    its owners, text, the post that raised it, whether it is open, the reviews in a row that kept it
    open right after its worker disputed it (streak), each owner's last answer and the verdict that last judged it."""
    members, found, latest = state["members"], {}, {}
    for post in posts:
        if post["seq"] <= state.get("accepted_seq", 0):
            continue
        if post.get("kind") == "ready":
            worker = post.get("subject", post["agent"])
            latest.pop(worker, None)
            owed = {name: f for name, f in found.items() if f["open"] and worker in f["owners"]}
            answers = answers_in(post["text"], owed.keys())
            for name, finding in owed.items():  # an open id the report leaves out, or answers with no evidence, is unanswered
                finding["answers"][worker] = (*answers.get(name, ("missing", "")), post["seq"])
            continue
        # Only what the post itself records makes it a verifier's verdict or ruling: its author's role may have changed
        # since, and a later change neither erases a defect nor turns a worker's word into a ruling.
        if "rejects" not in post and not post.get("rules"):
            continue
        word = REPORT_WORD.match(post["text"])
        if word and word[1] == "VERIFIED":  # a pass closes what it covers: the verifier saw every open id and passed
            for finding in found.values():
                # Owners are their successors' (as a NOT PASSED's are below), so the workers a pass covered are too.
                if not post.get("partial") or set(finding["owners"]) <= {successor(m, members) for m in post.get("members", [])}:
                    finding["open"] = False
            continue
        rulings = rulings_in(post["text"])
        # A replaced worker's findings are its successor's: the defects are still in the work it took over.
        names = ([successor(name, members) for name in rejected(post, members)]
                 if word and word[1] == "NOT PASSED" else [])
        if not names and word and word[1] == "NOT PASSED":
            continue  # a verdict on a candidate since replaced reviewed none of the standing work: it rules on nothing
        if not names:  # any other post of a verifier's can close an id, and nothing more
            for name, ruling in rulings.items():
                if name in found and ruling == "resolved":
                    found[name]["open"] = False
            continue
        raised = dict(tagged(post["text"]))
        # A second verdict on one candidate, such as test results added to a source review, is the same review.
        again = post.get("candidate") is not None and all(latest.get(name) == post["candidate"] for name in names)
        for name, finding in found.items():
            if not set(finding["owners"]) & set(names):
                continue
            if not finding["open"] and name not in raised:  # raising a closed id again reopens it; a bare ruling does not
                continue
            finding["open"] = name in raised or rulings.get(name) != "resolved"
            if raised.get(name):  # the verifier's latest wording is what the worker answers
                finding["text"] = raised[name]
            if not finding["open"]:
                finding["streak"] = 0
                continue
            # Silence is no ruling: a verdict that raises only something else leaves the id open and judges nothing
            # about it. A second verdict on one candidate is the same review, but the first of them to rule on an
            # answer is the ruling on it. Each owner answers for itself: one that fixed its part does not settle
            # another's dispute.
            unruled = [kind for owner, (kind, _, seq) in finding["answers"].items()
                       if owner in names and seq > finding["judged"].get(owner, 0)]
            if (name in raised or rulings.get(name) == "open") and (unruled or not again):
                if unruled:  # with no answer since the last ruling, a review judges nothing new: the streak stands
                    finding["streak"] = finding["streak"] + 1 if "disputed" in unruled else 0
                for owner in names:  # a verdict about one owner leaves another's answer still to be judged
                    if owner in finding["owners"]:
                        finding["judged"][owner] = post["seq"]
        for name in post.get("findings", []):
            found[name] = {"id": name, "owners": names, "text": raised.get(name, ""), "seq": post["seq"], "open": True,
                           "streak": 0, "judged": dict.fromkeys(names, post["seq"]), "answers": {},
                           "by": post["agent"]}
        for name in names:
            latest[name] = post.get("candidate")
    # A member retired with no successor takes its findings with it: nobody is left to answer them.
    return {name: f for name, f in found.items() if any(not members.get(owner, {}).get("killed") for owner in f["owners"])}


def disputes(found):
    """The open findings a worker disputed and a verifier kept open, DISPUTE_PAUSE reviews in a row. A worker that has
    answered since, by fixing it or disputing it anew, has moved on: the next review says where that stands."""
    return [finding for finding in found.values() if finding["open"] and finding["streak"] >= DISPUTE_PAUSE and disputers(finding)]


def disputers(finding):
    """The owners whose dispute of FINDING a verdict has judged and kept open."""
    return [owner for owner, (kind, _, seq) in finding["answers"].items()
            if kind == "disputed" and seq < finding["judged"].get(owner, 0)]


def attention(state, posts):
    """What needs someone, each item naming the post that shows it, and a view of every member."""
    members = state["members"]
    team, ready = team_of(members), readiness(members, posts)
    items, asked = [], {}
    if state.get("paused"):
        items.append({"kind": "paused", "member": COORDINATOR, "seq": 0, "text": "The run is paused: " + state["paused"]})
    budget, total = budget_usage(state)
    if budget and total >= budget and state.get("paused") != spent(budget):  # nobody is woken, whatever the pause says
        items.append({"kind": "paused", "member": COORDINATOR, "seq": 0,
                      "text": "The token budget is spent (%s of %s), so nobody is woken. Raise it with limit budget=<tokens>, then resume"
                              % (f"{total:,}", f"{budget:,}")})
    if not state.get("closed"):
        owed = unread_of(COORDINATOR, members, posts)
        if owed:  # a coordinator that follows the run some other way leaves reports and questions unseen
            items.append({"kind": "unread", "member": COORDINATOR, "seq": owed[0],
                          "text": "@coordinator has not read %d %s addressed to it, from #%d on. Run: read coordinator"
                                  % (len(owed), "post" if len(owed) == 1 else "posts", owed[0])})
        for name, post in latest_reports(posts).items():
            if name in team and post.get("kind") == "finding":
                items.append({"kind": "review", "member": name, "seq": post["seq"],
                              "text": "@%s's finding needs the coordinator to review the evidence" % name})
    for name, failed in rework(state, posts).items():
        if name in team and len(failed) >= REWORK_WARNING:
            items.append({"kind": "rework", "member": name, "seq": failed[-1],
                          "text": "@%s failed verification %d times in a row. Stop the rework and ask the user how to go on"
                                  % (name, len(failed))})
    for finding in disputes(ledger(state, posts)):
        owners = [name for name in disputers(finding) if name in team]
        if owners:
            items.append({"kind": "dispute", "member": owners[0], "seq": max(finding["judged"].values()),
                          "text": "@%s disputes %s and @%s keeps it open: %s. Settle it: decide, or give a consultant the "
                                  "finding and both positions. Then resume, and have @%s post `%s: resolved` or tell @%s to fix it"
                                  % (owners[0], finding["id"], finding["by"], finding["text"][:160] or "see the post",
                                     finding["by"], finding["id"], owners[0])})
    usage = state.get("usage", {})
    tokens = usage.get("tokens", {})
    actors = tokens.keys() - {COORDINATOR}
    # Two members are compared with each other: one doing most of a pair's work is common, nearly all of it is not.
    pair = sum(tokens[key] for key in actors) if len(actors) == 2 else 0
    if (total >= SPEND_FLOOR and len(actors) >= 3) or pair >= SPEND_FLOOR:
        whole, share, of = (pair, PAIR_SHARE, "the %s tokens the run's two members used") if pair else (total, SPEND_SHARE, "the run's %s tokens")
        for name, member in team.items():
            used = tokens.get(usage_key(member), 0)
            if used > whole * share:
                items.append({"kind": "spend", "member": name, "seq": 0,
                              "text": "@%s has used %s of %s (%d%%)" % (name, f"{used:,}", of % f"{whole:,}", used * 100 // whole)})
    for name, member in team.items():
        if heavy(name, member, posts):
            report = max(p["seq"] for p in posts if p["agent"] == name)
            items.append({"kind": "heavy", "member": name, "seq": report,
                          "text": "@%s holds %s tokens of context and is not woken any more: each wake would read all of it "
                                  "again, at full price once its cache is cold. Its report is #%d. For more work on its piece, "
                                  "replace it: replace %s %s-2" % (name, f"{int(member['held']):,}", report, name, name)})
    for name, member in team.items():
        if member.get("paused"):
            items.append({"kind": "member_paused", "member": name, "seq": 0,
                          "text": "@%s is paused: %s. Raise it with member %s budget=<tokens>, then resume %s"
                                  % (name, member["paused"], name, name)})
        elif member.get("role") in {"worker", "verifier"} and member.get("id"):
            key = usage_key(member)
            mark = usage.get("marks", {}).get(key, [0, 0])  # steps and tokens when it last posted or read
            turns, used = usage.get("steps", {}).get(key, 0) - mark[0], tokens.get(key, 0) - mark[1]
            if turns >= LOOP_STEPS or used > LOOP_TOKENS:
                items.append({"kind": "loop", "member": name, "seq": 0,
                              "text": "@%s has taken %d model steps and %s tokens since it last posted or read the board. "
                                      "Ask it where it stands, or stop it" % (name, turns, f"{used:,}")})
    for seq, asker, recipient in unanswered(members, posts):
        items.append({"kind": "question", "member": recipient, "seq": seq,
                      "text": "@%s has not answered @%s" % (recipient, asker)})
        asked.setdefault(asker, seq)
    for name, member in team.items():  # briefed, but no agent: a spawn that never happened or was cut off
        owed = unwoken_of(name, members, posts)
        if not member.get("id") and owed and runnable(name, members, posts, ready):
            items.append({"kind": "unstarted", "member": name, "seq": owed[0],
                          "text": "@%s has a brief and no agent. Start it once and record its id" % name})
    awake = [name for name, member in team.items() if not member.get("paused")]  # a paused member is woken by nobody
    for name in awake:
        if unreachable(name, members, posts):
            items.append({"kind": "unreachable", "member": name, "seq": unwoken_of(name, members, posts)[-1],
                          "text": "@%s could not be woken after %d attempts. Retry it or replace it" % (name, WAKE_ATTEMPTS)})
    for name in awake:
        if ignored(name, members, posts):
            items.append({"kind": "ignored", "member": name, "seq": unread_of(name, members, posts)[-1],
                          "text": "@%s was woken %d times and has not read its mentions. Run retry %s, or replace it" % (name, WAKE_ATTEMPTS, name)})
    for name, member in team.items():
        if name in ready:
            continue
        for dep in unmet(member, members, ready):
            upstream = members.get(dep, {})
            why = ("is missing" if not upstream else "was removed" if upstream.get("killed")
                   else "is paused: %s" % upstream["paused"] if upstream.get("paused")
                   else "is unreachable" if unreachable(dep, members, posts)
                   else "is ignoring its mentions" if ignored(dep, members, posts)
                   else "was never started" if "id" not in upstream and "id" in member
                   and runnable(dep, members, posts, ready) else None)
            if why:
                last = [p["seq"] for p in posts if p["agent"] == dep]
                items.append({"kind": "blocked", "member": name, "seq": last[-1] if last else 0,
                              "text": "@%s waits for @%s, which %s" % (name, dep, why)})
    def passed(post):  # a partial candidate's pass is not the run's
        protocol = REPORT_WORD.match(post["text"])
        return (members.get(post["agent"], {}).get("role") == "verifier" and protocol and protocol[1] == "VERIFIED"
                and not post.get("partial"))

    verified = [p for p in posts if passed(p)]
    if verified:
        changed = [p for p in posts if p["seq"] > verified[-1]["seq"] and p.get("kind") in {"ready", "revise"}
                   and members.get(p.get("subject", p["agent"]), {}).get("consult") != "1"]
        if changed:
            subj = changed[0].get("subject", changed[0]["agent"])
            items.append({"kind": "stale", "member": verified[-1]["agent"], "seq": verified[-1]["seq"],
                          "text": "VERIFIED (#%d) is older than @%s's change (#%d)" % (verified[-1]["seq"], subj, changed[0]["seq"])})
    for name, post in ready.items():  # a trial merge `ready` ran, while both reports it compared are current
        for peer, clash in post.get("conflicts", {}).items():
            if ready.get(peer, {}).get("seq") == clash["seq"]:
                items.append({"kind": "conflict", "member": name, "seq": post["seq"],
                              "text": "@%s's commit and @%s's (#%d) both change %s, so merging them will conflict. "
                                      "Have them agree who changes what" % (name, peer, clash["seq"], ", ".join(clash["files"]))})
    closed = bool(state.get("closed"))
    if closed:  # a finished run asks for nothing: what was left open is history
        items, asked = [], {}
    view = {name: {"type": kind_of(member), "model": model_of(member), "effort": effort_of(member),
                   "depends": dependencies(member), "owns": member.get("owns", ""),
                   "ready": name in ready,
                   "blocked_on": [] if closed or name in ready or member.get("killed") else unmet(member, members, ready),
                   "asked": asked.get(name, 0), "unreachable": not closed and name in awake and unreachable(name, members, posts),
                   "paused": bool(member.get("paused")), "heavy": not closed and heavy(name, member, posts)}
            for name, member in members.items() if name != COORDINATOR}
    # Counted over the whole journal: the pane reads only the newest posts of a board past its read limit.
    sent, unread = {}, {}
    for post in posts:
        sent[post["agent"]] = sent.get(post["agent"], 0) + 1
        for name in post.get("to", []):
            seen = members[name].get("last_read_seq") if isinstance(members.get(name), dict) else None
            if isinstance(seen, int) and post["seq"] > seen:
                unread[name] = unread.get(name, 0) + 1
    return {"items": items, "members": view, "sent": sent, "unread": unread}


def attention_text(report):
    lines = ["[%s] %s%s" % (item["kind"], "#%d " % item["seq"] if item["seq"] else "", item["text"]) for item in report["items"]]
    return "\n".join(lines + ["%d item(s) need attention; `show --post=N` prints one post" % len(lines) if lines else "nothing needs attention"])


def budget_usage(state):
    budget = int(state.get("limits", {}).get("budget", "0"))
    total = sum(state.get("usage", {}).get("tokens", {}).values())
    return budget, total


def spent(budget):
    return f"token budget of {budget} spent"


def usage_key(member):
    """The key a member's usage is kept under: a hash of its agent address, which the hooks report turns by."""
    return hashlib.sha256(("swarm-agent:" + member.get("id", "")).encode()).hexdigest()


def member_budget(state, member):
    return int(member.get("budget") or state.get("limits", {}).get("member_budget")
               or member.get("alloc", 0) * MEMBER_CAP)


def allocation(state):
    """Each active member's share of an allocated budget, the coordinator's, and the reserve."""
    team = {name: m for name, m in team_of(state["members"]).items() if not m.get("killed")}
    # Size sets the effort when none is named, so it is counted once: only an effort named for the member, against
    # its type's default, moves the share again.
    def named(m):
        base = DEFAULTS.get(kind_of(m), ("", ""))[1]
        return EFFORT_COST.get(m.get("effort"), 1) / EFFORT_COST.get(base, 1) if m.get("effort") and not m.get("sized") else 1
    shares = {name: round(ALLOWANCE.get(kind_of(m), ALLOWANCE["worker"]) * SIZES.get(m.get("size") or "m", 1) * named(m))
              for name, m in team.items()}
    return shares, COORDINATOR_BASE + COORDINATOR_PER_MEMBER * len(team), int(sum(shares.values()) * RESERVE)


def allocate(state):
    """While the budget is the board's to set and nobody has started, it follows the planned team. It freezes when the
    first member starts: from then on only the user's word (`limit budget=`) moves it, so a coordinator cannot raise
    its own bound by adding members. Never stored at or below what is used: that would pause the run at once."""
    members = state.get("members", {})
    team = team_of(members) if COORDINATOR in members else {}
    if not state.get("auto_budget") or not team:
        return
    shares, coordinator, reserve = allocation(state)
    if state["auto_budget"] is not True or any(m.get("id") for name, m in members.items() if name != COORDINATOR):
        state["auto_budget"] = "fixed"  # for good: a retired first member does not open it again
        # The total stays, but a member added since still gets a share to be stopped at: with none it could spend
        # whatever the run has left. Shares already given are kept.
        for name in shares:
            members[name].setdefault("alloc", shares[name])
        return
    for name, member in members.items():  # a member retired before any start gives its share back
        if name in shares:
            member["alloc"] = shares[name]
        else:
            member.pop("alloc", None)
    total = min(sum(shares.values()) + coordinator + reserve, AUTO_MAX)
    if total > budget_usage(state)[1]:
        state.setdefault("limits", {})["budget"] = str(total)


def pause_over_budget(state, names):
    """Pauses each of NAMES already at its own budget, as `account` does when a turn crosses it: a budget lowered
    under what a member has spent stops it now, not a turn later."""
    tokens = state.get("usage", {}).get("tokens", {})
    for name in names:
        member = state["members"][name]
        own = member_budget(state, member)
        if (name != COORDINATOR and not member.get("killed") and member.get("id") and own
                and tokens.get(usage_key(member), 0) >= own):
            # Already paused, it keeps its pause, under the budget now in force, as the run's own pause does.
            was, member["paused"] = member.get("paused"), spent(own)
            if not was:
                print("paused: @%s, %s. Raise it with member %s budget=<tokens>, then resume %s" % (name, member["paused"], name, name))


def progress(state, member):
    """Note that MEMBER posted or read: the loop check counts its turns and tokens from here. True when that changed."""
    usage, key = state.get("usage", {}), usage_key(member)
    mark = [usage.get("steps", {}).get(key, 0), usage.get("tokens", {}).get(key, 0)]
    if not member.get("id") or mark == usage.get("marks", {}).get(key, [0, 0]):
        return False
    usage.setdefault("marks", {})[key] = mark
    return True


# What a report spent before weighting, and what started its turn: `<wake>:<fresh input>,<cache writes>,<cache reads>,<output>`.
# A step's report ends with the context that step read (`,<held>`): a turn's end sums several steps and says none.
USAGE_DETAIL = re.compile(r"([a-z]+(?:\+[a-z]+){0,3}):([0-9]{1,15}),([0-9]{1,15}),([0-9]{1,15}),([0-9]{1,15})(?:,([0-9]{1,15}))?")
# A read-only member's context past this is read again whole at every wake, and written again whole, at full price,
# once its cache has gone cold. Seen live: three investigators resumed at 290k cost about 0.9M before one tool call.
# The hooks hold the same figure (CONTEXT_STOP) and stop such a member's tools there.
CONTEXT_STOP = 200_000
# How the hooks head a member's final report when they put it on the board for it (its turn ended with none there).
HANDBACK = "HAND-BACK"


def heavy(name, member, posts):
    """Whether waking NAME would only pay for its context again: a read-only member past the ceiling whose report is
    on the board. With no report it is woken once more, to write one: its tools are stopped, its work is not lost."""
    return (kind_of(member) in READ_ONLY and not member.get("killed") and int(member.get("held", 0)) >= CONTEXT_STOP
            and (name in latest_reports(posts) or any(p["agent"] == name and HANDBACK in p["text"][:80] for p in posts)))
DETAIL_COLUMNS = ("Steps", "Fresh input", "Cache writes", "Cache reads", "Output")


def account(d, args):
    turn, actor, count = args[:3]
    detail = USAGE_DETAIL.fullmatch(args[3]) if len(args) > 3 else None
    if len(args) > 3 and not detail:
        sys.exit("invalid usage detail")
    if not BIND_KEY.fullmatch(turn) or (actor != COORDINATOR and not BIND_KEY.fullmatch(actor)):
        sys.exit("invalid usage key")
    if not re.fullmatch(r"[1-9][0-9]{0,15}", count):
        sys.exit("expected a positive token count")
    state = load_state(d)
    if state.get("closed"):  # a turn that ends after the run did is not the run's
        budget, total = budget_usage(state)
        print(json.dumps({"title": state["title"], "total": total, "budget": budget, "paused": False}))
        return
    usage = state.setdefault("usage", {})
    tokens = usage.setdefault("tokens", {})
    turns = usage.setdefault("turns", {})
    recorded = turn not in turns
    if recorded:
        turns[turn] = int(count)
        tokens[actor] = tokens.get(actor, 0) + turns[turn]
        steps = usage.setdefault("steps", {})
        steps[actor] = steps.get(actor, 0) + 1
        if detail:
            # Kept beside the weighted count, never in place of it: budgets and pauses read `tokens` alone.
            row = usage.setdefault("detail", {}).setdefault(actor, {}).setdefault(detail[1], [0] * len(DETAIL_COLUMNS))
            row[:] = [had + more for had, more in zip(row, [1, *map(int, detail.groups()[1:5])])]
            if detail[6]:  # kept on the roster, so it outlasts the hooks' own memory of it across a restart
                for member in state["members"].values():
                    if member.get("id") and usage_key(member) == actor:
                        member["held"] = int(detail[6])
        # Only a retried report repeats a turn, and it does so at once: the oldest entries are never asked about again.
        for old in list(turns)[:-TURNS_KEPT]:
            del turns[old]
    budget, total = budget_usage(state)
    paused = bool(budget and total >= budget and not state.get("paused"))
    if paused:
        state["paused"] = spent(budget)
    result = {"title": state["title"], "total": total, "budget": budget, "paused": paused}
    # Older runs stored only True for a recorded report, with no amount to echo on a retry.
    if type(turns[turn]) is int:
        result["accepted"] = turns[turn]
    # A member over its own budget stops alone: the others keep running.
    for name, member in state["members"].items():
        own = member_budget(state, member)
        if (name != COORDINATOR and not member.get("killed") and member.get("id") and usage_key(member) == actor
                and own and tokens.get(actor, 0) >= own and not member.get("paused")):
            member["paused"] = spent(own)
            result["member_paused"] = name
    if recorded or paused or "member_paused" in result:
        save(d, state)
    print(json.dumps(result))


def binding_file(root, key):
    if os.path.basename(os.path.abspath(root)) != ".swarm" or not BIND_KEY.fullmatch(key):
        sys.exit("invalid run binding")
    return os.path.join(root, ".bindings", key)


def saved_runs(root):
    if not os.path.isdir(root):
        return
    names = (name for name in os.listdir(root) if RUN_NAME.fullmatch(name))
    for name in sorted(names, key=lambda name: (name.rstrip("x")[-15:], name), reverse=True):
        try:
            yield name, load_state(os.path.join(root, name))
        except (OSError, ValueError):
            continue


def prune(root, args):
    """Remove the integration checkouts no candidate needs any more and archive closed runs nobody has touched."""
    spans = [a.partition("=")[2] for a in args if re.fullmatch(r"--days=[0-9]{1,5}", a)]
    if len(spans) > 1 or len(set(args)) != len(args) or set(args) - {"--dry-run", *("--days=" + span for span in spans)}:
        sys.exit("prune accepts --days=N and --dry-run")
    root = os.path.abspath(root)  # Git is handed paths under it: a relative one that starts with "-" would read as an option
    if os.path.basename(root) != ".swarm" or not os.path.isdir(root):
        sys.exit("prune takes the project's .swarm folder")
    would, older = "would " if "--dry-run" in args else "", time.time() - int(spans[0] if spans else 14) * 86400
    import verify  # late: verify.py imports this module
    project = verify.Path(root).parent  # the folder .swarm is in, also where .swarm is a link to somewhere else
    git_dir = verify.git(project, "rev-parse", "--absolute-git-dir", optional=True)
    removed = archived = 0

    def registered():
        listed = verify.git(project, "worktree", "list", "--porcelain", optional=True) or b""
        return {os.path.realpath(line[len("worktree "):].strip()) for line in listed.decode(errors="replace").splitlines()
                if line.startswith("worktree ")}

    gone = set()  # worktrees a dry run reports it would remove: a real prune has removed them before it looks
    with open(os.path.join(root, ".adopt.lock"), "w") as choosing:
        fcntl.flock(choosing, fcntl.LOCK_EX)  # no run is adopted or bound while runs move
        runs = list(saved_runs(root))
        if git_dir:
            # Held so that no candidate is being prepared: its checkout exists before its record does.
            with verify.verification_lock(verify.Path(os.fsdecode(git_dir.rstrip(b"\n")))):
                known = registered()
                for run, state in runs:
                    try:
                        with open(os.path.join(root, run, "verification.json"), encoding="utf-8") as f:
                            candidate = json.load(f)
                    except (OSError, ValueError):
                        candidate = {}
                    if not isinstance(candidate, dict):
                        candidate = {}
                    kept = None if state.get("closed") or candidate.get("accepted") else "integration-%s" % candidate.get("candidate")
                    baselines_path = os.path.join(root, run, verify.BASELINES_FILE)
                    try:
                        with open(baselines_path, encoding="utf-8") as f:
                            raw_baselines = json.load(f)
                    except (OSError, ValueError):
                        raw_baselines = []
                    recorded_baselines = {b for b in raw_baselines if isinstance(b, str)} if isinstance(raw_baselines, list) else set()
                    remaining_baselines = set(recorded_baselines)
                    run_entries = set(os.listdir(os.path.join(root, run)))
                    for name in sorted(run_entries):
                        path = os.path.join(root, run, name)
                        # Only ever a folder of this name directly inside a run folder: never a member's own checkout.
                        # Baseline directories are removed only when recorded by verification, never manually created ones.
                        is_integration = name.startswith("integration-")
                        is_baseline = name.startswith("baseline-") and name in recorded_baselines
                        if (not is_integration and not is_baseline) or name == kept or os.path.islink(path) or not os.path.isdir(path):
                            continue
                        # Asked before anything is removed, so a dry run reports exactly what a prune would do.
                        if os.path.realpath(path) not in known:
                            print("kept %s: Git does not know it as a worktree" % path)
                        elif (wt_status := verify.git(path, "status", "--porcelain", "--untracked-files=all", "--ignored", optional=True)) is None or wt_status.strip():
                            # Ignored files count: `git worktree remove` refuses untracked ones but deletes those.
                            print("kept %s: worktree has uncommitted changes, or untracked or ignored files" % path)
                        elif would or verify.git(project, "worktree", "remove", path, optional=True) is not None:
                            print("%sremove worktree %s" % (would, path))
                            gone.add(os.path.realpath(path))
                            remaining_baselines.discard(name)
                            removed += 1
                        else:
                            print("kept %s: Git could not remove it" % path)
                    if not would and recorded_baselines:
                        remaining_baselines &= run_entries
                        if remaining_baselines != recorded_baselines:
                            if remaining_baselines:
                                atomic_write(baselines_path, json.dumps(sorted(remaining_baselines)) + "\n")
                            else:
                                try:
                                    os.unlink(baselines_path)
                                except OSError:
                                    pass
                if not would:
                    verify.git(project, "worktree", "prune", optional=True)
        worktrees = [wt for wt in (registered() if git_dir else ()) if not would or wt not in gone]
        try:  # the run the pane shows when a conversation has none of its own stays where the pointer says
            with open(os.path.join(root, "current"), encoding="utf-8") as f:
                shown = f.read().strip()
        except OSError:
            shown = ""

        def mtime_of(path):
            try:
                return os.lstat(path).st_mtime
            except OSError:
                return 0

        moved = set()
        for run, state in runs:
            if run == shown:
                continue
            source, target = os.path.join(root, run), os.path.join(root, "archive", run)
            newest = max((mtime_of(os.path.join(folder, name)) for folder, _, names in os.walk(source) for name in names), default=0)
            if not state.get("closed") or newest > older or os.path.exists(target):
                continue
            source_real = os.path.realpath(source)
            if any(wt == source_real or wt.startswith(source_real + os.sep) for wt in worktrees):
                print("kept %s: contains active git worktree" % run)
                continue
            if not would:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                try:
                    held = open(os.path.join(source, ".lock"), "a")
                except OSError:  # a read-only copy has no board command writing in it
                    held = open(os.path.join(source, "members.json"), "rb")
                with held:
                    # A board command at work in the folder finishes first: moved under it, its next write would fail.
                    # Taken after the .swarm folder's lock, as `adopt` takes the two.
                    fcntl.flock(held, fcntl.LOCK_EX)
                    os.rename(source, target)
            print("%sarchive %s" % (would, run))
            moved.add(run)
            archived += 1
        # A pointer to a run folder that is gone (deleted by hand) shows the pane nothing: it goes too.
        if shown and not os.path.isdir(os.path.join(root, shown)):
            if not would:
                os.unlink(os.path.join(root, "current"))
            print("%sremove the pointer to %s, which is gone" % (would, shown))
        # A conversation's pointer to a run that was archived or deleted finds nothing: `restore` looks the run up anew.
        bindings, stale = os.path.join(root, ".bindings"), 0
        for key in sorted(os.listdir(bindings)) if os.path.isdir(bindings) else []:
            try:
                with open(os.path.join(bindings, key), encoding="utf-8") as f:
                    named = f.read().strip()
            except (OSError, UnicodeError):
                continue
            if BIND_KEY.fullmatch(key) and (not RUN_NAME.fullmatch(named) or named in moved
                                           or not os.path.isdir(os.path.join(root, named))):
                if not would:
                    os.unlink(os.path.join(bindings, key))
                stale += 1
        if stale:
            print("%sremove %d stale binding(s)" % (would, stale))
    print("%sremove %d worktree(s) and archive %d run(s)" % (would, removed, archived))


def mentions(text):
    """The names TEXT mentions outside code. The name as written also reaches a roster made before names had to end
    in a letter or digit. A name that only says whose post is cited ("per @lead #5", "from @novelty (post #6)")
    addresses nobody: seen live, a note to one member that named two others as its sources woke both for nothing."""
    return {form for m in MENTION.findall(CITED.sub(" ", QUOTED.sub(" ", text))) for form in (m.lower(), m.lower().rstrip("-_"))}


def targets(text, members, *, include_killed=False, sender=None):
    """The names a post reaches: its @name, @group and @all mentions, @verifiers (every verifier) and @dependents (whoever
    depends on SENDER), expanded to live members (or all when include_killed)."""
    mentioned = mentions(text)
    return [n for n, m in members.items() if (include_killed or not m.get("killed")) and (
        mentioned & {"all", n, m.get("group")} or ("verifiers" in mentioned and m.get("role") == "verifier")
        or ("dependents" in mentioned and sender is not None and sender in dependencies(m)))]


def show(post):
    head = "#%d %s @%s -> %s" % (post["seq"], post["time"][11:19], post["agent"], " ".join("@" + t for t in post["to"]) or "-")
    return head + "\n" + "\n".join("  " + line for line in post["text"].split("\n")) + "\n"


def private(d):
    """Run data holds code, check output and whatever a member printed: only its owner may open the run folder.
    Everything inside it, the journal and the verification logs among them, is then out of other accounts' reach."""
    if os.path.basename(os.path.dirname(os.path.abspath(d))) != ".swarm":  # only a run folder, as `init` makes them
        return
    try:
        status = os.stat(d)
        if status.st_uid == os.getuid() and status.st_mode & 0o077:
            os.chmod(d, 0o700)
    except OSError:  # a read-only copy, or a folder another account owns: left as it is
        pass


def init(d, title):
    parent, name = os.path.split(os.path.abspath(d))
    if os.path.basename(parent) != ".swarm":  # never write a "*" .gitignore anywhere else
        sys.exit("DIR must be <project>/.swarm/<swarm-name>")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", name) or not title.strip():
        sys.exit("init requires a run name starting with a letter or digit and using letters, digits, dots, underscores or hyphens, and a nonempty title")
    os.makedirs(parent, exist_ok=True)
    # Under the lock `prune` and `adopt` hold: the pointer written here is not one `prune` is about to take away,
    # and of two runs started at once neither reads a .gitignore the other is still writing.
    with open(os.path.join(parent, ".adopt.lock"), "w") as choosing:
        fcntl.flock(choosing, fcntl.LOCK_EX)
        run = "%s-%s" % (name, time.strftime("%Y%m%d-%H%M%S"))
        while True:  # mkdir is atomic, so two runs started in the same second get two folders
            try:
                os.mkdir(os.path.join(parent, run), 0o700)
                break
            except FileExistsError:
                run += "x"
        d = os.path.join(parent, run)
        try:  # keeps the whole .swarm folder out of git; a file already there is the project's own
            with open(os.path.join(parent, ".gitignore"), "x", encoding="utf-8") as f:
                f.write("*\n")
        except FileExistsError:
            with open(os.path.join(parent, ".gitignore"), encoding="utf-8") as f:
                if "*" not in [line.strip() for line in f]:
                    print("note: %s does not ignore everything, so run data will show in git status. "
                          "Verification leaves it out of the source fingerprint either way."
                          % os.path.join(parent, ".gitignore"), file=sys.stderr)
        open(os.path.join(d, "board.jsonl"), "a").close()
        save(d, {"title": title, "members": {COORDINATOR: {"role": COORDINATOR, "last_read_seq": 0}},
                 "limits": {"budget": str(DEFAULT_BUDGET)}, "auto_budget": True})
        atomic_write(os.path.join(parent, "current"), run + "\n")
    print(d)
    print("note: the run pauses at %s tokens until the team is registered; `plan` then shows the budget allocated from it. "
          "The user names another with limit budget=<tokens>, or budget= for none" % f"{DEFAULT_BUDGET:,}", file=sys.stderr)


def main(argv):
    if len(argv) < 3:
        sys.exit(USAGE)
    d, cmd, args = argv[1], argv[2], argv[3:]
    if cmd not in ARG_COUNTS:
        sys.exit(USAGE)
    minimum, maximum = ARG_COUNTS[cmd]
    if len(args) < minimum or (maximum is not None and len(args) > maximum):
        sys.exit(f"wrong number of arguments for {cmd}\n{USAGE}")
    if cmd == "init":
        return init(d, " ".join(args))
    if cmd == "restore":
        path = binding_file(d, args[0])
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                name = f.read().strip()
            if RUN_NAME.fullmatch(name):
                try:
                    saved = load_state(os.path.join(d, name))
                    if saved.get("binding") == args[0] and not saved.get("closed"):
                        print(os.path.abspath(os.path.join(d, name)))
                        return
                except (OSError, ValueError):
                    pass
        # A crash can commit the roster before the private pointer is written.
        candidates = [name for name, state in saved_runs(d) if state.get("binding") == args[0] and not state.get("closed")]
        if len(candidates) == 1:
            print(os.path.abspath(os.path.join(d, candidates[0])))
        return
    if cmd == "prune":
        return prune(d, args)
    if cmd == "agent-run":
        binding_file(d, args[0])
        matches = [(name, state) for name, state in saved_runs(d) if state.get("binding") == args[0] and any(
            member.get("id") in args[1:] for member in state["members"].values())]
        open_matches = [name for name, state in matches if not state.get("closed")]
        # With no open run, the latest that had the agent: a native teammate's address comes back in each run of the
        # conversation, and a killed run must still own it so its tool calls stay refused. Two open runs stay unknown.
        chosen = open_matches if len(open_matches) == 1 else [] if open_matches else [name for name, _ in matches[:1]]
        if len(chosen) == 1:
            print(os.path.abspath(os.path.join(d, chosen[0])))
        return
    if cmd in {"adopt", "locate"}:
        # The conversation that starts a registered member owns its run, however its board commands were typed.
        # It never guesses: a run named in HINT (the member's prompt) wins, then a run this conversation
        # already owns, then the only unowned run with the member. Two unowned candidates are refused.
        key, name, hint = args[0], args[1].lstrip("@").lower(), " ".join(args[2:])
        binding_file(d, key)
        # Two conversations starting members at the same moment must not both see a run as unowned and
        # both choose it: the choice and the binding happen under one lock for the whole .swarm folder.
        # It is always taken before a run's own lock, never after, so the two cannot deadlock.
        if os.path.isdir(d):
            try:
                choosing = open(os.path.join(d, ".adopt.lock"), "w")
                fcntl.flock(choosing, fcntl.LOCK_EX)  # held until the process exits
            except OSError:
                if cmd != "locate":
                    raise
        runs = list(saved_runs(d))
        mine, unowned, open_runs = [], [], 0
        for run, found in runs:
            member = found.get("members", {}).get(name)
            if not found.get("closed") and found.get("binding") in (None, key):
                open_runs += 1
            if found.get("closed") or not member or member.get("killed") or found.get("binding") not in (None, key):
                continue
            (unowned if found.get("binding") is None else mine).append(run)
        pool = mine or unowned
        eligible = mine + unowned
        named_eligible = [run for run in eligible if re.search(r"(?<![\w.-])%s(?![\w.-])" % re.escape(run), hint)]
        named_all = [run for run, _ in runs if re.search(r"(?<![\w.-])%s(?![\w.-])" % re.escape(run), hint)]
        if len(named_eligible) > 1 or (not named_eligible and not named_all and len(pool) > 1):
            print("ambiguous: " + " ".join(named_eligible if len(named_eligible) > 1 else pool), file=sys.stderr)
            sys.exit(3)
        if not named_eligible and named_all:
            sys.exit(5)
        chosen = named_eligible[0] if len(named_eligible) == 1 else pool[0] if pool else None
        if chosen is None:
            # A run this conversation could drive is open and does not know the name: an unregistered member.
            sys.exit(4 if open_runs else 0)
        if cmd == "locate":
            print(os.path.abspath(os.path.join(d, chosen)))
            return
        d, cmd, args = os.path.join(d, chosen), "bind", [key]
        adopted = True
    else:
        adopted = False
    if not os.path.exists(os.path.join(d, "members.json")):
        sys.exit("no swarm run at %s; `init` prints the run folder to use as DIR" % d)
    if cmd == "bind" and not adopted:  # a run must not change owner while `adopt` is choosing one
        binding_file(os.path.dirname(os.path.abspath(d)), args[0])
        choosing = open(os.path.join(os.path.dirname(os.path.abspath(d)), ".adopt.lock"), "w")
        fcntl.flock(choosing, fcntl.LOCK_EX)

    private(d)  # a run made before runs were private is closed on its next command

    if cmd == "tail":
        # For a reader with a size limit (the pane reads at most 4 MiB): whole lines only, newest last. Takes no lock.
        if args and not re.fullmatch(r"[1-9][0-9]{0,8}", args[0]):
            sys.exit("tail takes a byte count")
        budget = int(args[0]) if args else 3_000_000
        with open(os.path.join(d, "board.jsonl"), "rb") as f:
            size = f.seek(0, os.SEEK_END)
            if size > budget:
                f.seek(size - budget - 1)
                data = f.read(budget + 1).partition(b"\n")[2]
            else:
                f.seek(0)
                data = f.read(budget)
        end = data.rfind(b"\n")
        data = data[:end + 1] if end != -1 else b""
        if size > budget and not data:
            sys.exit("tail: final post exceeds byte budget")
        sys.stdout.buffer.write(data)
        return

    try:
        lock = open(os.path.join(d, ".lock"), "a")
        lock_mode = fcntl.LOCK_EX
    except OSError:
        if cmd not in READ_COMMANDS:
            raise
        try:
            lock = open(os.path.join(d, ".lock"), "rb")
        except FileNotFoundError:  # an old read-only copy may lack a lock file
            lock = open(os.path.join(d, "members.json"), "rb")
        lock_mode = fcntl.LOCK_SH
    with lock:
        fcntl.flock(lock, lock_mode)  # released when the process exits
        if cmd == "account":
            return account(d, args)
        state, posts = load(d, repair=lock_mode == fcntl.LOCK_EX)
        members = state["members"]
        budget, total = budget_usage(state)
        over_budget = bool(budget and total >= budget)
        if state.get("closed") and cmd in {"member", "started", "replace", "post", "limit", "retry", "pause", "resume"}:
            sys.exit("the run is closed")

        def unread(name):
            return unread_of(name, members, posts)

        def unwoken(name):  # unread mentions nobody has woken the member for yet
            return unwoken_of(name, members, posts)

        def known(name):
            name = name.lstrip("@").lower()
            if name not in members:
                sys.exit("unknown member @%s; members: %s" % (name, " ".join("@" + n for n in members)))
            return name

        def post_message(sender, text, recipients, *, save_roster=False, **extra):
            post = {"seq": len(posts) + 1, "agent": sender, "text": text,
                    "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "to": recipients, **extra}
            if sender == COORDINATOR and (head := REPORT_WORD.match(text)) and head[1] == "BRIEF":
                # Who the first line assigned, as the roster stood: groups and retirements later change no brief.
                post["addressed"] = [n for n in targets(text.split("\n")[0], members, sender=sender) if n != sender]
            if post.get("kind") == "ready":
                current = readiness(members, [*posts, post])
                subject, named = post.get("subject", sender), targets(text, members, sender=sender)
                # A dependent is woken by the READY that lets it start, not by each one before it; a mention always reaches.
                recipients = [name for name in recipients if name in named or subject not in dependencies(members[name])
                              or not unmet(members[name], members, current)]
                post["to"] = recipients
                if any(entry.get("role") == "worker" and entry.get("consult") != "1" and name not in current
                       for name, entry in team_of(members).items()):
                    # A verifier hears before the last READY only of the workers its reviews= names: reviewed while
                    # the worker's context is still warm, at the price of one verifier wake for each.
                    recipients = [name for name in recipients if members[name].get("role") != "verifier"
                                  or {subject, "all"} & set(filter(None, members[name].get("reviews", "").split(",")))]
                    post["to"] = recipients
            marked = progress(state, members[sender])
            if save_roster:
                state["pending_post"] = post
                save(d, state)
            append_post(d, post)
            if save_roster:
                del state["pending_post"]
            if save_roster or marked:
                save(d, state)
            print("posted #%d -> %s" % (post["seq"], " ".join("@" + t for t in recipients) or "nobody"))
            owed = unread(sender)
            if owed:  # the one notice that reaches a member whatever started it and whatever hooks are loaded
                print("UNREAD: %d post(s) address @%s from #%d on. Read them now: read %s"
                      % (len(owed), sender, owed[0], sender))
            return post

        def judge_last_pass():
            """The last candidate and why its pass no longer holds, recorded for `export` once the run is closed."""
            try:
                with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
                    candidate = json.load(f)
            except (OSError, ValueError):
                candidate = None
            stale = None
            if isinstance(candidate, dict) and candidate.get("verified_by") and not candidate.get("accepted"):
                # Judged while the run is open, as the board judges a VERIFIED post, and kept for `export` afterwards.
                stale = stale_pass(d, candidate, bool(state.get("closed")))
                if stale and not state.get("closed"):
                    candidate["stale"] = stale
                    atomic_write(os.path.join(d, "verification.json"), json.dumps(candidate, indent=2))
            return candidate, stale

        def waiting(member):
            """Whether MEMBER may be woken. One that is `heavy` is not: every path that wakes goes through here."""
            return (not state.get("closed") and not state.get("paused") and not over_budget and not member.get("killed")
                    and not member.get("paused")
                    and not heavy(next(n for n, m in members.items() if m is member), member, posts))

        def checkout_head(why, tail):
            """This checkout's HEAD commit, refused while it has edits HEAD does not hold: WHY says what they would spoil."""
            # Resolved here, in the member's own checkout: a worktree-isolated agent is refused a command
            # that feeds `git rev-parse` into another, so it cannot pass the ID itself in one call.
            import verify  # late: verify.py imports this module; its git() ignores an inherited GIT_DIR
            here = os.getcwd()
            found = verify.git(here, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
            if found is None:
                sys.exit("HEAD is no commit here: run `%s` from your checkout%s" % (cmd, tail))
            # HEAD of a checkout with edits in it is not the work being reported: the edits are. A new file
            # nobody added counts: verification merges the commit and would never see it.
            try:
                top = verify.toplevel(here)
                if top is None:
                    raise ValueError("it is not inside a Git checkout")
                # Run data is the .swarm folder of this run's project, which need not be the top of the
                # repository: the same path is left out of the member's own checkout.
                project = verify.repository(verify.Path(os.path.dirname(os.path.dirname(os.path.abspath(d)))))
                loose = verify.pending_changes(verify.Path(os.fsdecode(top.rstrip(b"\n"))), project and project[1])
            except (ValueError, OSError) as error:
                sys.exit("git could not read this checkout, so HEAD cannot be %s: %s" % ("reported" if cmd == "ready" else "used", error))
            if loose:
                names = ", ".join(shown(path) for path in loose[:5]) + (" and more" if len(loose) > 5 else "")
                sys.exit("this checkout has uncommitted changes or untracked files, so %s: %s. "
                         "Commit them or add them to .gitignore first%s" % (why, names, tail))
            return here, found.decode().strip()

        def relocked():
            """The board as it stands once the lock, let go while git worked, is held again: the caller checks anew
            whatever it had checked, since any member's command may have run meanwhile."""
            fcntl.flock(lock, fcntl.LOCK_EX)
            return load(d)

        def run_plan(author):
            """Prepare the run's planned candidate, if one is planned and the team is ready, and hand the verifiers its
            test command in the coordinator's name. Called after each step that can complete the team: a READY, a
            confirmed finding, a retirement, the plan itself. The board's state decides this step, so no turn of the
            coordinator's is spent on it. Seen live: each candidate cost the coordinator a wake at 180k tokens to run
            one command and post its output. The lock is let go meanwhile: verify.py takes it, and a merge may take
            long. The candidate on the table is kept when it already holds these files and reports."""
            nonlocal state, posts, members
            plan = planned(d)
            if not plan:
                return
            fcntl.flock(lock, fcntl.LOCK_UN)
            run_dir = os.path.abspath(d)
            project = os.path.dirname(os.path.dirname(run_dir))
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify.py")
            done = subprocess.run([sys.executable, "-B", script, run_dir, project, "prepare", *plan, "--keep-standing"],
                                  capture_output=True, text=True, stdin=subprocess.DEVNULL)
            state, posts = relocked()
            members = state["members"]
            why = done.stderr.strip()
            made = json.loads(done.stdout.strip().split("\n")[-1]) if done.returncode == 0 else {}
            if made.get("standing"):
                print("candidate %s on the table already holds these files and reports: no new one was prepared"
                      % made["candidate"])
            elif done.returncode == 0:
                # One post for every verifier: each runs the command with its own name last.
                verifiers = [name for name, entry in members.items() if entry.get("role") == "verifier" and not entry.get("killed")]
                command = shlex.join(["python3", script, run_dir, project, "test", made["candidate"]])
                if verifiers:
                    last = (verifiers[0], "") if len(verifiers) == 1 else ("<you>", ", with your own name in place of <you>")
                    post_message(COORDINATOR, "%s CANDIDATE %s (path %s, digest %s), prepared from the run's plan now that "
                                 "every worker is READY. Review every READY you have not answered against your brief, "
                                 "then run exactly%s:\n%s %s" % (
                                     " ".join("@" + name for name in verifiers), made["candidate"], made["path"],
                                     made["digest"], last[1], command, last[0]), verifiers)
                print("candidate %s was prepared from the run's plan%s" % (
                    made["candidate"], " and its test command posted to the verifier" if verifiers
                    else ". No verifier is registered: its test command is\n%s <verifier>" % command))
            elif "waiting for READY from" in why or "worker readiness changed" in why or "there are no active workers" in why:
                if author == COORDINATOR and cmd == "dispatch":
                    print("planned: the step that completes the team prepares this candidate and posts its test command "
                          "to the verifier. Nothing is prepared yet (%s)" % why.replace("verification: ", ""))
            elif author == COORDINATOR:
                print("the planned candidate could not be prepared: " + why)  # the coordinator's own command: it reads this
            else:
                # Not this READY's to settle alone: the coordinator hears, and so does each worker a line names.
                told = [COORDINATOR, *(n for n in targets(why, members, sender=author) if n not in (author, COORDINATOR))]
                post_message(author, "@coordinator The planned candidate could not be prepared after this READY:\n" + why, told)
                print("the planned candidate could not be prepared: " + why)

        def unmerged(repo, deps, revision):
            """The dependencies, of {name: READY post}, whose READY commit REVISION does not contain."""
            return [dep for dep, post in deps.items() if post.get("revision") and not is_ancestor(repo, post["revision"], revision)]

        if cmd == "started":
            name = known(args[0])
            member = members[name]
            address, expected = args[1], args[2]
            isolated = None
            if len(args) == 4:
                if args[3] not in {"isolated=0", "isolated=1"}:
                    sys.exit("started optional 4th argument must be isolated=0 or isolated=1")
                isolated = args[3].partition("=")[2]
            if member.get("killed") or name == COORDINATOR:
                sys.exit("the assignment is no longer active")
            validate_member(name, member, {"id": address}, members)
            if member.get("id") == address:
                dirty = False
                for key in ("wake_claim", "last_nudged_seq", "told"):
                    if key in member:
                        member.pop(key, None)
                        dirty = True
                if isolated is not None and member.get("isolated") != isolated:
                    member["isolated"] = isolated
                    dirty = True
                if dirty:
                    save(d, state)
                return
            if member.get("id", "") != expected:
                sys.exit("the roster address changed while the agent was starting")
            # What the old agent read, the new one has not.
            for key in AGENT_STATE:
                member.pop(key, None)
            member["id"] = address
            started_as(member)
            if isolated is not None:
                member["isolated"] = isolated
            else:
                member.pop("isolated", None)
            save(d, state)

        elif cmd == "member":
            name = args[0].lstrip("@").lower()
            # a member registered before names had to end in a letter or digit stays manageable
            if name not in members and not usable_name(name, members):
                sys.exit("bad member name %r: use lowercase letters, digits, underscores and hyphens, ending in a letter or digit, and not a group's name or %s"
                         % (name, ", ".join(sorted(RESERVED))))
            before_counts, before_family = roster_counts(state), set(family_limit_errors(state))
            was_fable_inv = (name in members and kind_of(members[name]) == "investigator"
                             and family(model_of(members[name])) == "fable")
            created = name not in members
            member = members.setdefault(name, {"role": "worker", "last_read_seq": len(posts)})
            previous = member.copy()
            changes = assignments(args[1:], MEMBER_FIELDS)
            if created and "killed" in changes:
                sys.exit("@%s is not on the roster, so there is nobody to retire. Nothing was changed" % name)
            # A retired member's record is history: its role still says whose verdicts and reports its posts were.
            if previous.get("killed") and changes.keys() - {"killed"}:
                sys.exit("@%s has been retired, so its assignment no longer changes. To put a member in its place: replace %s NEW"
                         % (name, name))
            if "id" in changes and changes["id"] != member.get("id"):
                for key in AGENT_STATE:
                    member.pop(key, None)
                if "isolated" not in changes:
                    member.pop("isolated", None)
            if member.get("profile") in READ_ONLY and "profile" in changes and changes["profile"] not in READ_ONLY and "writes" not in changes:
                member.pop("writes", None)  # a specialist turned worker or designer writes again unless told otherwise
            waited = set(dependencies(previous))
            member.update(changes)
            merge_after(member, changes, previous.get("after", ""))
            if "reviews" in changes:
                set_reviews(member, changes["reviews"], members)
            if member.get("killed"):  # a retired member runs no more turns: nothing is paused
                member.pop("paused", None)
                member.setdefault("retired_at", len(posts))
                standing = readiness({**members, name: previous}, posts).get(name, {}).get("revision")
                if standing and "killed" not in previous:
                    member["stood"] = standing  # the commit that counted when it left: work built on it stays good
            validate_member(name, member, changes, members)
            if changes.get("id"):  # after validation, which takes any effort= as named: one left empty comes from the size
                started_as(member)
            if changes.get("group") in {"", "-"}:
                member.pop("group", None)
            if "role" in changes or "consult" in changes:
                stranded(name, members)
            if kind_of(member) == "investigator" and family(model_of(member)) == "fable":
                if not was_fable_inv:
                    sys.exit("an investigator starts on Opus. Fable is the escalation after an Opus investigator fails: "
                             "board.py DIR replace OLD NEW model=fable effort=medium")
                if effort_of(member) != "medium":
                    sys.exit("a Fable investigator runs at medium effort")
            if "depends" in changes:
                deps = dependencies(member)
                member["depends"] = ",".join(deps)
                # Only the names this command adds, as `replace` checks them: a wait the member already had for one
                # retired since stays, or an after= could never be added to it.
                if any(dep not in members or members[dep].get("role") != "worker"
                       or members[dep].get("killed") or members[dep].get("consult") == "1" for dep in deps if dep not in waited):
                    sys.exit("dependencies must be registered, active non-consultant workers")
                frontier = list(deps)
                seen = set()
                while frontier:
                    dep = frontier.pop()
                    if dep == name:
                        sys.exit("dependency cycle")
                    if dep not in seen:
                        seen.add(dep)
                        frontier.extend(dependencies(members.get(dep, {})))
            errors = added_limit_errors(state, before_counts, before_family)
            if errors:
                sys.exit("over the run's limits, nothing was changed: " + "; ".join(errors))
            if "budget" in changes:  # only now, when nothing above can refuse the change it reports
                pause_over_budget(state, [name])
            if model_of(member).lower() == "inherit" and any(f in state.get("limits", {}) for f in FAMILIES):
                print(f"note: @{name} has model=inherit, which cannot be checked against family limits here", file=sys.stderr)
            if (not member.get("killed") and assignment_scope(previous) != assignment_scope(member)
                    and latest_reports(posts).get(name, {}).get("kind") in {"ready", "finding"}):
                recipients = [name] + [n for n, entry in team_of(members).items() if n != name and (
                    name in dependencies(entry) or (entry.get("role") == "verifier" and in_play(d, name, members)))]
                what = ("Review your scope and report again." if member.get("role") == "worker" else
                        "You are a %s now: your earlier report is withdrawn, and a %s posts no READY." % (member["role"], member["role"]))
                # It reaches the member ahead of the coordinator's own instruction. Seen live: a member ended its turn
                # on this notice alone, saying it could not act on it yet, and its hand-back woke the coordinator.
                what += (" The coordinator's instruction follows in a later post: read the board again for it before you "
                         "answer or report, and do not end your turn on this notice alone.")
                return post_message(COORDINATOR, f"@{name} Your assignment changed. {what}",
                                    recipients, kind="revise", subject=name, save_roster=True)
            if "killed" in changes and not previous.get("killed"):
                # Whoever only came after the retired member, and waits for nobody else, starts now: no READY will say so.
                through = readiness(members, posts)
                freed = [n for n, entry in team_of(members).items()
                         if name in soft(entry) and n not in through and not unmet(entry, members, through)]
                old_members = {**members, name: previous}
                old_ready = readiness(old_members, posts)
                workers = {w for w, e in team_of(members).items() if e.get("role") == "worker" and e.get("consult") != "1"}
                # A member that never started and posted nothing held nothing the verifier has: a verifier addressed
                # since the newest READY already has the work. Seen live: retiring one woke the verifier only to answer
                # that nothing changes, and its hand-back woke the coordinator.
                started = previous.get("id") or any(p["agent"] == name for p in posts)
                newest = max((p["seq"] for p in through.values()), default=0)
                if workers and workers <= through.keys() and any(
                    e.get("role") == "worker" and e.get("consult") != "1" and w not in old_ready
                    for w, e in team_of(old_members).items()
                ):
                    freed.extend(n for n, entry in team_of(members).items() if entry.get("role") == "verifier" and (
                        started or not any(n in p.get("to", ()) for p in posts if p["seq"] >= newest)))
                freed = list(dict.fromkeys(freed))
                if freed:
                    post_message(COORDINATOR, "%s @%s was retired and reports nothing. Go on without it (if you merged its commit, rebuild without it), and name in "
                                        "your report what is missing for that." % (" ".join("@" + n for n in freed), name),
                                 freed, save_roster=True)
                    return run_plan(COORDINATOR)
            save(d, state)
            if changes.get("killed"):
                run_plan(COORDINATOR)  # so may a retirement, of the last worker that was not ready

        elif cmd == "dispatch":  # verify.py's, after `prepare --when-ready` recorded the plan
            if state.get("closed"):
                sys.exit("the run is closed")
            run_plan(COORDINATOR)

        elif cmd == "limit":
            changes = assignments(args, LIMITS)
            if any(changes[k] != "" and not re.fullmatch(r"[0-9]{1,15}", changes[k])
                   for k in changes if k in ("max_workers", "max_members", "budget", "member_budget")):
                sys.exit("limits are max_workers=N max_members=N budget=TOKENS member_budget=TOKENS and <model>=<types>, "
                         "for models: " + " ".join(FAMILIES))
            for model in FAMILIES:
                if changes.get(model):  # stored as the list it is: "architect,,architect" and "," are not two more forms
                    changes[model] = ",".join(dict.fromkeys(token for token in changes[model].split(",") if token))
                    if not changes[model]:
                        sys.exit("%s takes agent types (%s), member names, or none" % (model, ", ".join(DEFAULTS)))
                for token in changes.get(model, "").split(","):
                    if token in {"", "none"} or token in DEFAULTS:
                        continue
                    if not NAME.fullmatch(token):
                        sys.exit("%s=%s: list agent types (%s), member names, or none" % (model, changes[model], ", ".join(DEFAULTS)))
                    if token not in members:  # a name registered later is fine; a typo would lock the model for everyone
                        print("note: %s=%s names no agent type and no member yet. Types are: %s" % (model, token, ", ".join(DEFAULTS)))
            # A budget the run has already spent could only stop it at once, members mid-work and a verifier mid-test
            # included. Seen live: a coordinator asked to "limit the tokens" set 1.3M on a run that had used 7.7M.
            _, used = budget_usage(state)
            if changes.get("budget") and not state.get("paused") and 0 < int(changes["budget"]) <= used:
                sys.exit("The run has already used %s tokens, so budget=%s would pause it at once and stop every member "
                         "mid-work. Set a budget above what is used (used plus what the rest may cost), or stop the run "
                         "with pause" % (f"{used:,}", changes["budget"]))
            limits = state.setdefault("limits", {})
            if "budget" in changes:  # the user's figure, or none: the board allocates no more
                state.pop("auto_budget", None)
                for member in members.values():  # nor stops anyone at a share of a budget it no longer sets
                    member.pop("alloc", None)
            for k, v in changes.items():
                if v == "" or (k in ("budget", "member_budget") and not int(v)):  # a budget of zero is no budget
                    limits.pop(k, None)
                else:
                    limits[k] = v
            budget, total = budget_usage(state)
            if budget and total >= budget:
                if not state.get("paused"):  # as `account` does when a turn crosses it
                    state["paused"] = spent(budget)
                    print("paused: %s (%d used). Raise it with limit budget=<tokens>, then resume" % (state["paused"], total))
                elif state["paused"].startswith("token budget of "):
                    state["paused"] = spent(budget)
            if "member_budget" in changes:
                pause_over_budget(state, members)
            save(d, state)
            print("limits: " + (" ".join("%s=%s" % kv for kv in state["limits"].items()) or "none"))
            for error in limit_errors(state):
                print("over limit: " + error)

        elif cmd == "plan":
            team = team_of(members)
            print("Team plan: %s" % state["title"])
            print("  %-16s %-13s %-8s %-7s %-18s %s" % ("member", "type", "model", "effort", "waits for", "owns"))
            for name, member in team.items():
                print("  %-16s %-13s %-8s %-7s %-18s %s" % ("@" + name, kind_of(member), family(model_of(member)), effort_of(member),
                                                           ",".join(dependencies(member)) or "-", member.get("owns") or member.get("paths") or "-"))
            models = Counter(family(model_of(member)) for member in team.values())
            print("  %d members: %s" % (len(team), ", ".join("%d %s" % (count, model) for model, count in models.most_common())))
            if state.get("limits"):
                print("  limits: " + " ".join("%s=%s" % kv for kv in state["limits"].items()))
            for error in limit_errors(state):
                print("  over limit: " + error)
            if state.get("auto_budget") and team:
                _, coordinator, reserve = allocation(state)
                frozen = state["auto_budget"] != True or any(m.get("id") for m in team.values())
                # Once fixed, the coordinator's share and the reserve are whatever the members' shares leave of it.
                print("  budget: %s tokens, allocated from this team%s: %s%s" % (
                    f"{budget:,}", " and fixed since the first member started" if frozen else "",
                    ", ".join("@%s %s" % (n, f"{team[n].get('alloc', 0):,}") for n in team if "alloc" in team[n]),
                    "" if frozen else ", coordinator %s, reserve %s" % (f"{coordinator:,}", f"{reserve:,}")))
                if not frozen:
                    print("  note: a piece is sized m unless told: member <name> size=s for one file or question, size=l for a "
                          "piece across sub-systems. Only the user changes the total: limit budget=<tokens>")
            if budget and team:
                # The budget stands, whoever set it, so the plan is what has to fit it: said before anyone starts, not
                # at the pause. An allocated one is short too when the team is estimated past what the board allocates.
                shares, coordinator, reserve = allocation(state)
                estimate = sum(shares.values()) + coordinator + reserve
                if estimate > budget:
                    costly = sorted(shares, key=shares.get, reverse=True)[:3]
                    print("  over budget: this team is estimated at %s tokens, the budget is %s. Before anyone starts, merge or "
                          "drop pieces, shrink one with size=s, lower an effort, or ask the user about the budget. Costliest: %s"
                          % (f"{estimate:,}", f"{budget:,}", ", ".join("@%s %s" % (n, f"{shares[n]:,}") for n in costly)))
            if not budget:
                print("  note: no token budget is set. `limit budget=<tokens>` pauses the run when it is spent")
            if len(team) > 1:
                print("  note: a post to @all wakes all %d members for a turn each. Mention a name or a group when fewer need it" % len(team))

        elif cmd == "attention":
            if args and args != ["--json"]:
                sys.exit("attention accepts only --json")
            report = attention(state, posts)
            if "--json" in args:
                print(json.dumps(report))
            else:
                print(attention_text(report))

        elif cmd == "retry":
            name = known(args[0])
            if name == COORDINATOR or members[name].get("killed"):
                sys.exit("only active team members can be retried")
            for key in ("wake_claim", "told", "last_nudged_seq"):
                members[name].pop(key, None)
            save(d, state)
            print("delivery to @%s will be tried again" % name)

        elif cmd == "replace":
            old, new = known(args[0]), args[1].lstrip("@").lower()
            # A removed member can still be replaced: that is how the members waiting for it get a successor.
            if old == COORDINATOR or new in members or not usable_name(new, members):
                sys.exit("replace needs an existing member and a new, unused name that is not a group's")
            if members[old].get("replaced_by"):
                sys.exit("@%s was already replaced by @%s; replace @%s instead" % (old, members[old]["replaced_by"], members[old]["replaced_by"]))
            before_counts, before_family = roster_counts(state), set(family_limit_errors(state))
            entry = {key: value for key, value in members[old].items() if key in INHERITED}
            if members[old].get("sized"):  # an effort its size gave it: the successor takes its own from the size
                entry.pop("effort", None)
            given = assignments(args[2:], MEMBER_FIELDS - {"killed", "backend"})
            entry.update(given)
            if members[old].get("profile") in READ_ONLY and "profile" in given and given["profile"] not in READ_ONLY and "writes" not in given:
                entry.pop("writes", None)  # as in `member`: a specialist turned worker or designer writes again unless told otherwise
            if (kind_of(entry) == "investigator" and family(model_of(entry)) == "fable"
                    and not (kind_of(members[old]) == "investigator" and family(model_of(members[old])) in {"opus", "fable"}
                             and effort_of(entry) == "medium")):
                sys.exit("Fable escalation requires replacing an Opus investigator with model=fable effort=medium")
            entry["last_read_seq"] = len(posts)
            if "alloc" in members[old]:  # the piece changes hands, and its share with it
                entry["alloc"] = members[old]["alloc"]
            # As at a retirement: the commit that counted when it left, so work built on a report that stood stays good.
            standing = readiness(members, posts).get(old, {}).get("revision")
            if standing:
                members[old]["stood"] = standing
            members[old]["killed"] = "1"
            members[old]["replaced_by"] = new
            members[old].pop("paused", None)
            # Folded before it is validated, as `member` does: a verifier is refused a wait given as after= too. Only
            # the names this command asks for are checked as new: an inherited wait for a retired member stays.
            asked = ",".join(filter(None, [given.get("depends", ""), given.get("after", "")]))
            named = {"depends", "after"} & given.keys()
            merge_after(entry, given, members[old].get("after", ""))
            if named:
                given["depends"] = asked
            validate_member(new, entry, given, members)
            if "reviews" in given:
                set_reviews(entry, given["reviews"], members)
            if given.get("id"):  # started as it is registered, as in `member`
                started_as(entry)
            if given.get("group") in {"", "-"}:
                entry.pop("group", None)
            if "depends" in given:
                entry["depends"] = ",".join(dependencies(entry))
            members[new] = entry
            # Resolved through the chain: a question put to an earlier, already retired member is the successor's too.
            open_questions = [seq for seq, _, recip in unanswered(members, posts) if successor(recip, members) == new]
            for member in members.values():  # whoever waited for the old member now waits for the new one
                if member.get("depends"):
                    member["depends"] = ",".join(dict.fromkeys(new if dep == old else dep for dep in dependencies(member)))
                if member.get("after"):
                    member["after"] = ",".join(dict.fromkeys(new if dep == old else dep for dep in member["after"].split(",")))
                if member.get("reviews"):  # and whoever reviewed its READY early reviews the successor's
                    member["reviews"] = ",".join(dict.fromkeys(new if dep == old else dep for dep in member["reviews"].split(",")))
            stranded(new, members)
            # Only what this command asks for: an inherited wait for a removed member is the blocked
            # state Attention already lists, and replacing the waiter must stay possible.
            if any(dep not in members or members[dep].get("role") != "worker" or members[dep].get("killed")
                   or members[dep].get("consult") == "1" for dep in dependencies(given)):
                sys.exit("dependencies must be registered, active non-consultant workers; nothing was changed")
            looped = cyclic(members)
            if looped:
                sys.exit("dependency cycle through @%s: a member that waited for @%s would wait for itself; nothing was changed"
                         % (looped, old))
            errors = added_limit_errors(state, before_counts, before_family)
            if errors:
                sys.exit("over the run's limits, nothing was changed: " + "; ".join(errors))
            if model_of(entry).lower() == "inherit" and any(f in state.get("limits", {}) for f in FAMILIES):
                print(f"note: @{new} has model=inherit, which cannot be checked against family limits here", file=sys.stderr)
            briefs = [p for p in posts if p["agent"] == COORDINATOR and old in p["to"]
                      and (word := REPORT_WORD.match(p["text"])) and word[1] == "BRIEF"]
            # A brief assigned to the old member alone is its own; one assigned to others too is shared: it goes along,
            # but never stands in for the member's own. A brief records whom its first line assigned. An older one
            # without that record goes by its `to`, with the first line telling a brief addressed to the member from
            # one that names it further down; when none was addressed to it, those that name it stand in.
            def addressed(p):
                head, _, rest = p["text"].partition("\n")
                return old in targets(head, members, include_killed=True, sender=COORDINATOR) or old not in mentions(rest)
            heads = [(p, [n for n in p["addressed"] if n != new]) for p in briefs if old in p.get("addressed", [])]
            heads += [(p, [n for n in p["to"] if n != new]) for p in briefs if "addressed" not in p and addressed(p)]
            heads.sort(key=lambda head: head[0]["seq"])
            own = [p for p, reached in heads if reached == [old]] or ([] if heads else [p for p in briefs if "addressed" not in p])
            shared = [p for p, reached in heads if len(reached) > 1]

            def brief_body(post):
                lines = post["text"].split("\n")
                first = lines[0][REPORT_WORD.match(lines[0]).end():].strip()
                return "\n".join(([first] if first else []) + lines[1:])

            parts = ["Shared brief #%d: %s" % (p["seq"], brief_body(p)) for p in shared] + [brief_body(p) for p in own[-1:]]
            body = "\n".join(parts) or "(@%s had no brief on the board)" % old
            history = " ".join("#%d" % p["seq"] for p in posts if p["agent"] == old) or "none"
            # what the old member was sent and never read (or left unanswered) would otherwise be lost with it
            owed_seqs = sorted({p["seq"] for p in posts if old in p["to"] and p["seq"] > members[old]["last_read_seq"]}
                               | set(open_questions))
            owed = " ".join("#%d" % seq for seq in owed_seqs)
            inherited = ["%s (#%d): %s" % (name, finding["seq"], finding["text"][:160] or "see the post")
                         for name, finding in ledger(state, posts).items() if finding["open"] and new in finding["owners"]]
            post_message(COORDINATOR, "@%s BRIEF (replaces %s)\n%s\nPredecessor: %s was removed. Its posts: %s. "
                         "Read them before you start, with the show command for %s, and do not redo what they report as done.%s%s"
                         % (new, old, body, old, history, old,
                            " It left these posts addressed to it unread or unanswered, which are now yours to answer: %s." % owed if owed else "",
                            "\nThe verifier's open findings on this work are yours. Answer each in your READY, as `F1: fixed — "
                            "<evidence>` or `F1: disputed — <evidence>`:\n- " + "\n- ".join(inherited) if inherited else ""),
                         [new], save_roster=True)
            print("spawn @%s as swarm:%s, then record its id" % (new, kind_of(entry)))

        elif cmd == "post":
            sender = known(args[0])
            if members[sender].get("killed"):
                sys.exit(f"@{sender} has been retired")
            text = " ".join(args[1:]).strip()
            if not text:
                sender_id = members[sender].get("id")
                fcntl.flock(lock, fcntl.LOCK_UN)
                text = sys.stdin.read().strip()
                if not text:
                    sys.exit("empty post")
                state, posts = relocked()
                members = state["members"]
                if state.get("closed"):
                    sys.exit("the run is closed")
                if sender not in members or members[sender].get("killed"):
                    sys.exit(f"@{sender} has been retired")
                if sender != COORDINATOR and members[sender].get("id") != sender_id:
                    sys.exit(f"@{sender}'s agent changed while reading stdin. Nothing was posted")
            # A report typed as a post records no readiness: verification would wait for it forever.
            protocol = REPORT_WORD.match(text)
            word = protocol[1] if protocol else ""
            if sender != COORDINATOR and (word in {"READY", "REVISE"} or (word == "FINDING" and kind_of(members[sender]) == "investigator")):
                if members[sender].get("role") != "worker":
                    sys.exit("%s is a worker's report and records nothing from a verifier, whose verdict is VERIFIED, "
                             "NOT PASSED or NOT VERIFIED. Start the post with another word" % word)
                how = "ready %s (report on stdin)" % sender if word in {"READY", "FINDING"} else "revise %s <reason>" % sender
                sys.exit("this is a plain post, so it records no readiness. Use: board.py DIR %s" % how)
            # VERIFIED counts only as the line verify.py returns for a candidate it tested.
            first = text.split("\n")[0]
            if word == "VERIFIED" and members[sender].get("role") != "verifier":
                sys.exit("only a verifier can post VERIFIED")
            passed = word == "VERIFIED" and verified_line(d, sender, first)
            if word == "VERIFIED" and not passed:
                sys.exit("VERIFIED must be the line the coordinator's verify command returns: VERIFIED <candidate> <digest>. "
                         "Wait for the candidate; report anything else as NOT VERIFIED or as a note. "
                         "A pass a later NOT PASSED or NOT VERIFIED withdrew is restored only by running the test again.")
            recipients = [name for name in targets(text, members, sender=sender) if name != sender]
            if sender == COORDINATOR and word == "BRIEF" and (order := SHELL_ORDER.search(text)):
                # Refused, the brief is corrected in the same step. Seen live: three investigators told to read
                # `git diff` rebuilt it by comparing two copies of a 5,000-line file.
                # Whom the first line assigns, as `addressed` records: a member the text only refers to runs nothing.
                without = [name for name in targets(first, members, sender=sender) if name != sender and kind_of(members[name]) in READ_ONLY]
                if without:
                    sys.exit("%s no shell (%s read and search only), so the brief cannot have %s run `%s`. Run it yourself and "
                             "name the file its output is in, or give that step to a member with a shell. Nothing was posted"
                             % (" and ".join("@" + name for name in without) + (" has" if len(without) == 1 else " have"),
                                ", ".join(sorted({kind_of(members[name]) + "s" for name in without})),
                                "it" if len(without) == 1 else "them", next(part for part in order.groups() if part).strip()))
            stuck, verdict = "", {}
            if passed and passed.get("partial"):  # a pass of some workers' pieces, never the run's
                verdict = {"partial": True, "members": passed.get("members", [])}
            if word == "NOT PASSED" and members[sender].get("role") == "verifier":
                verdict["rejects"] = rejected({"agent": sender, "text": text, "to": recipients}, members)
            answer = why = current = None
            if word in {"NOT PASSED", "NOT VERIFIED"} and members[sender].get("role") == "verifier":
                answer, held, why, current, sure = answered(d, sender, first, members, posts)
                if answer:  # the candidate a verdict answers, so `resume` knows whose review is finished
                    verdict["candidate"] = answer
                if answer and current is None:
                    if "rejects" in verdict:  # about a candidate the accepted one replaced: it rejects no standing report
                        verdict["rejects"] = []
                elif answer == current:
                    void_pass(d, members, verdict.get("rejects", ()))
                elif held is not None and "rejects" in verdict:
                    # A verdict on a candidate since replaced withdraws the reports it held that still stand. A worker's
                    # newer report it withdraws only when the verifier has read it and nothing ties the verdict to the
                    # old candidate but the request it read last: a piece's NOT PASSED answers the READY reviewed.
                    latest, seen = latest_reports(posts), members[sender].get("last_read_seq", 0)

                    def answers(name):
                        standing = latest.get(name, {}).get("seq")
                        was = held[name][0] if isinstance(held.get(name), list) and held[name] else None
                        return standing is not None and (standing == was or (not sure and standing <= seen))

                    verdict["rejects"] = [name for name in verdict["rejects"] if answers(name)]
            # The verifier's verdict on the candidate it was testing: a later verdict naming none no longer answers it.
            done = members[sender].get("tested") if members[sender].get("role") == "verifier" else None
            done = bool(done) and done in (answer, passed and passed.get("candidate"))
            if done:
                del members[sender]["tested"]
            if members[sender].get("role") == "verifier" and (word == "VERIFIED" or rulings_in(text)):
                verdict["rules"] = True  # a verifier's when written: a later change of its role undoes no ruling
            given = []
            if word == "NOT PASSED" and verdict.get("rejects"):
                # Each defect gets its id here, in the text every reader sees: the worker answers by id, and the next
                # verdict rules by id.
                number = 1 + max((int(name[1:]) for entry in posts for name in entry.get("findings", [])), default=0)
                # Only a defect of the workers this verdict rejects is raised again by its id: another worker's id on a
                # bullet here is a new defect, which the rejected worker has to answer.
                owners = {successor(name, members) for name in verdict["rejects"]}
                text, given = tag_findings(text, {name for name, finding in ledger(state, posts).items()
                                                  if owners & set(finding["owners"])}, number, members=members)
                if given:
                    verdict["findings"] = given
            if word == "NOT PASSED" and members[sender].get("role") == "verifier" and not state.get("paused"):
                # Paused by the verdict itself, so a resumed run is stopped again only by a further one. Counted as the
                # board will count it once posted: a second verdict on one candidate is no new failure.
                seq = len(posts) + 1
                after = posts + [{"seq": seq, "agent": sender, "text": text, "to": recipients, **verdict}]
                failed = rework(state, after)
                stuck = next(("@%s failed verification %d times in a row" % (name, len(seqs)) for name, seqs in failed.items()
                              if seqs[-1] == seq and len(seqs) >= REWORK_PAUSE), "")
                # A worker that disputed a finding and a verifier that keeps it open will not settle it between them:
                # another round of rework only repeats the two positions.
                kept = [finding for finding in disputes(ledger(state, after)) if seq in finding["judged"].values()]
                if kept and not stuck:
                    stuck = "@%s disputes %s and @%s keeps it open" % (
                        ", @".join(sorted({owner for finding in kept for owner in disputers(finding)})),
                        ", ".join(finding["id"] for finding in kept), sender)
                if stuck:
                    state["paused"] = stuck
            post = post_message(sender, text, recipients, save_roster=bool(stuck) or done, **verdict)
            # An answer that cites nothing closes nothing: said now, it is corrected in the same step.
            still = [(seq, asker) for seq, asker, asked in unanswered(members, [*posts, post])
                     if not word and asked == sender and asker in post["to"]]
            if still:
                print("OPEN: %s still open to you; only citing it closes it, and a post of just `re #%d` wakes nobody"
                      % (", ".join("#%d from @%s" % pair for pair in still), still[0][0]))
            if current is not None and answer != current:
                print("note: this verdict is recorded as answering candidate %s, %s, so candidate %s, the one being verified "
                      "now, keeps its test and its pass. If it is about %s, post it again with that id in its first line"
                      % (answer, why, current, current))
            if verdict.get("partial"):
                print("note: this pass is of a partial candidate holding %s. It is not the run's pass, and verify.py never "
                      "accepts it" % ", ".join("@" + name for name in verdict["members"]))
            if given:
                print("recorded: %s. The worker answers each id in its next READY; `%s: resolved` on a line of a post "
                      "of yours closes one" % (", ".join(given), given[0]))
            if stuck:
                print("paused: %s. The coordinator asks the user how to go on" % stuck)

        elif cmd in {"ready", "revise"}:
            sender = known(args[0])
            member = members[sender]
            if state.get("closed") or member.get("role") != "worker" or member.get("killed"):
                sys.exit("only an active worker of an open run can " + cmd)
            if cmd == "ready":
                through = readiness(members, posts)
                blocked = unmet(member, members, through)
                if blocked:
                    sys.exit("waiting for " + ", ".join(blocked))
                revision = args[1] if len(args) > 1 else None
                if revision is not None and (member.get("writes") == "0" or kind_of(member) in READ_ONLY):
                    sys.exit("a read-only report cannot include a commit")
                if revision not in (None, "HEAD"):
                    revision = revision.lower()  # git reads either case; the board keeps one
                    if not COMMIT.fullmatch(revision):
                        sys.exit("expected a full commit ID, or HEAD from your checkout")
                conflicts, base, exclude, start = {}, None, [], None
                deps = {dep: through[dep] for dep in dependencies(member) if dep in through}
                reported = latest_reports(posts).get(sender, {}).get("seq")
                scope = (assignment_scope(member), member.get("id"))  # a replaced or restarted agent is another

                def latest_rejection():
                    return next((post["seq"] for post in reversed(posts) if sender in rejected(post, members)), None)

                rejection = latest_rejection()

                def revalidate(when):
                    if state.get("closed") or member.get("role") != "worker" or member.get("killed"):
                        sys.exit("only an active worker of an open run can ready, and @%s no longer is one: the board changed "
                                 "%s. Nothing was posted" % (sender, when))
                    if revision is not None and (member.get("writes") == "0" or kind_of(member) in READ_ONLY):
                        sys.exit("a read-only report cannot include a commit, and @%s was made read-only while git checked "
                                 "it. Nothing was posted" % sender)
                    if (unmet(member, members, through) or [dep for dep in dependencies(member) if dep in through] != list(deps)
                            or latest_reports(posts).get(sender, {}).get("seq") != reported
                            or any(through.get(dep, {}).get("seq") != post["seq"] for dep, post in deps.items())):
                        sys.exit("a dependency's report, @%s's own or its dependencies changed %s, "
                                 "so nothing was posted. Read the board, then report again" % (sender, when))
                    # A first READY has no earlier report a scope change withdraws: the work was done for the old scope.
                    if (assignment_scope(member), member.get("id")) != scope:
                        sys.exit("@%s's assignment changed %s, so nothing was posted. Read the "
                                 "board, check the work against the new assignment, then report again" % (sender, when))
                    if latest_rejection() != rejection:
                        sys.exit("@%s's work was rejected %s, so nothing was posted. Read the verdict, then report again"
                                 % (sender, when))

                if revision is not None:
                    import verify  # late: verify.py imports this module
                    repo = home = os.path.dirname(os.path.dirname(os.path.abspath(d)))  # the project, which holds every member's commits
                    # Compared with the reports that stay current once this one is posted: a member that depends on the
                    # sender loses its READY to it and will sync this commit anyway.
                    peers = {n: p["revision"] for n, p in readiness(members, [*posts, {"seq": len(posts) + 1, "agent": sender,
                             "text": "READY", "kind": "ready"}]).items() if n != sender and p.get("revision")}
                    synced = member.get("synced_deps") if isinstance(member.get("synced_deps"), dict) else {}
                    merged = [post.get("revision") for post in deps.values()] + [str(rev) for rev in synced.values()]
                    earlier = earlier_commits(sender, posts)
                    # Where the member's work began, as far as the board knows: the start its checkout recorded, and the
                    # base each READY of its own recorded (a fix on a new branch began inside the work it reported).
                    starts = [member["start"]] if isinstance(member.get("start"), str) else []
                    starts += [post["base"] for post in posts if post.get("kind") == "ready" and post.get("base")
                               and post.get("subject", post["agent"]) == sender]
                    # Git may take long (a large repository, hooks): every other board command runs meanwhile, and
                    # what was checked above is checked again once the lock is back.
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    if revision == "HEAD":
                        repo, revision = checkout_head("HEAD is not what you are reporting", ", or give the full commit ID")
                        if verify.git(home, "rev-parse", "--git-dir", optional=True) is None:
                            home = repo  # a project outside Git has no repository of its own to hold the commit
                        start = fresh(home, checkout_start(repo), earlier)
                    # A mistyped ID would otherwise stand as a report until verification failed to merge it, and so
                    # would a commit only a separate clone holds.
                    if verify.git(home, "cat-file", "-e", revision + "^{commit}", optional=True) is None:
                        sys.exit("%s is no commit in the project's repository. Commit your work in a worktree of the project "
                                 "(or fetch it into the project's repository) and give its full ID, or HEAD from your checkout"
                                 % revision)
                    held = carried(home, member, members, posts, revision, project_base(d, home))
                    if held:
                        sys.exit("your commit still holds @%s's commit %s, which had not passed when @%s was retired. "
                                 "Rebuild your work without it, then report again. Nothing was posted"
                                 % (held[0], held[1][:12], held[0]))
                    # A dependency's commit missing from this one would be merged beside it, untested with it.
                    behind = unmerged(home, deps, revision)
                    if behind:
                        sys.exit("your commit does not contain the READY commit of %s. Run `board.py DIR sync %s` from your "
                                 "checkout, check the result, then report again" % (", ".join("@" + n for n in behind), sender))
                    clashes = verify.trial_merge(home, None, revision, peers)
                    # A branch that merely ends at this commit says where the work began only when nothing better is
                    # known and it is the one such branch: of several, any could be somebody else's.
                    known_starts = [one for one in (start, *starts) if one]
                    guessed = [] if known_starts else branch_starts(home, revision)
                    base, exclude = own_range(home, revision, [*(guessed if len(guessed) == 1 else []), *known_starts],
                                              merged, earlier)
                    report = sys.stdin.read().strip("\r\n")
                    if not report.strip():
                        sys.exit("READY needs a report on stdin")
                    state, posts = relocked()
                    members = state["members"]
                    member = members[sender]
                    through = readiness(members, posts)
                    revalidate("while git checked the commit")
                    stays = readiness(members, [*posts, {"seq": len(posts) + 1, "agent": sender, "text": "READY", "kind": "ready"}])
                    # A peer that reported while git worked, a `ready` running beside this one included, was never
                    # compared: it is now, under the lock, so of two overlapping reports the later one names the clash.
                    arrived = {n: p["revision"] for n, p in stays.items()
                               if n != sender and p.get("revision") and peers.get(n) != p["revision"]}
                    if arrived:
                        for peer in arrived:
                            clashes.pop(peer, None)  # found against the commit it reported before
                        clashes.update(verify.trial_merge(home, None, revision, arrived))
                        peers.update(arrived)
                    conflicts = {peer: {"seq": stays[peer]["seq"], "files": files} for peer, files in clashes.items()
                                 if stays.get(peer, {}).get("revision") == peers[peer]}
                    if start and member.get("start") != start:
                        member["start"] = start  # where its branch began, for a later READY given as a bare commit ID
                    else:
                        start = None
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    report = sys.stdin.read().strip("\r\n")
                    if not report.strip():
                        sys.exit("READY needs a report on stdin")
                    state, posts = relocked()
                    members = state["members"]
                    member = members[sender]
                    through = readiness(members, posts)
                    revalidate("while reading stdin")
                # A report that passes over an open finding sends the verifier into a review of work nobody claims
                # to have done: refused here, it is corrected in the same step.
                # An investigator answers a rejected finding with a new one, which the coordinator reviews whole.
                owed = {name: finding for name, finding in ledger(state, posts).items()
                        if finding["open"] and sender in finding["owners"]
                        and kind_of(member) != "investigator" and member.get("consult") != "1"}
                silent = sorted(owed.keys() - answers_in(report, owed.keys()).keys(), key=lambda name: int(name[1:]))
                if silent:
                    sys.exit("the report leaves open findings unanswered: %s. Give each a line: `%s: fixed — <where, and "
                             "the check that shows it>`, or `%s: disputed — <the evidence that it is no defect>`. Nothing "
                             "was posted" % ("; ".join("%s (%s)" % (name, owed[name]["text"][:120] or "post #%d" % owed[name]["seq"])
                                                       for name in silent), silent[0], silent[0]))
                if kind_of(member) == "investigator":
                    # A new finding withdraws the one the coordinator confirmed: whoever built on that one hears,
                    # as it would of a `revise`.
                    confirmed = sender in through
                    told = [COORDINATOR] + [name for name, entry in team_of(members).items() if confirmed and name != sender and (
                        sender in dependencies(entry) or (entry.get("role") == "verifier" and in_play(d, sender, members)))]
                    note = ("This replaces the finding confirmed before: work built on that one waits until the "
                            "coordinator confirms this one.\n" if confirmed else "")
                    post_message(sender, "FINDING awaiting coordinator review\n" + note + report, told, kind="finding")
                    return
                text = "READY" + (" " + revision if revision else "") + "\n" + report
            else:
                revision, conflicts, base, exclude, start = None, {}, None, [], None
                text = ("REVISE " + " ".join(args[1:])).strip()
            # An investigator withdrawing a finding nobody confirmed changes nothing for anyone but the coordinator.
            notify = kind_of(member) != "investigator" or sender in readiness(members, posts)
            is_consultant = member.get("consult") == "1"
            recipients = [name for name, entry in members.items() if not entry.get("killed") and
                          name != sender and (name == COORDINATOR or (notify and (
                              (entry.get("role") == "verifier" and not is_consultant) or sender in dependencies(entry))))]
            if cmd == "revise" and not in_play(d, sender, members):
                # With no candidate that holds this member's work, a withdrawal costs nobody a turn: `prepare` refuses a
                # member that is not ready, and the READY that follows tells who needs it. A candidate being tested or
                # waiting to be accepted is another matter: it is dead from here on, so its verifier and the coordinator hear.
                # A member waiting on this one always hears, as does the coordinator when a finding it may confirm is withdrawn.
                recipients = [name for name in recipients if sender in dependencies(members[name])
                              or (name == COORDINATOR and kind_of(member) == "investigator")]
            if cmd == "ready" and kind_of(member) != "investigator" and not is_consultant:
                recipients.extend(name for name in targets(report, members, sender=sender) if name != sender and name not in recipients)
            post_message(sender, text, recipients, kind=cmd, revision=revision, **({"conflicts": conflicts} if conflicts else {}),
                         **({"base": base} if base else {}), **({"except": exclude} if exclude else {}))
            if start:
                save(d, state)
            for peer, clash in conflicts.items():
                print("conflict: @%s's READY #%d and this commit both change %s. Agree with @%s who changes what before "
                      "the candidate is prepared" % (peer, clash["seq"], ", ".join(clash["files"]), peer))
            if cmd == "ready" and kind_of(member) in READ_ONLY:
                # A read-only member's report is the background others would each read the sources for again: kept as
                # a file a brief can name. Seen live: three workers each read the same protocol and tooling documents.
                os.makedirs(os.path.join(d, "context"), exist_ok=True)
                kept = os.path.join(os.path.abspath(d), "context", sender + ".md")
                with open(kept, "w", encoding="utf-8") as f:
                    f.write(report + "\n")
                print("context: this report is kept at %s for briefs to name" % kept)
            if cmd == "ready":
                run_plan(sender)

        elif cmd == "sync":
            name = known(args[0])
            member = members[name]
            if args[1:] not in ([], ["--check-only"]):
                sys.exit("sync accepts only --check-only")
            if state.get("closed") or member.get("role") != "worker" or member.get("killed"):
                sys.exit("only an active worker of an open run can sync")
            if member.get("writes") == "0" or kind_of(member) in READ_ONLY:  # as `ready` refuses it a commit
                sys.exit("a read-only member reports no commit, so it has nothing to sync")
            through = readiness(members, posts)
            blocked = unmet(member, members, through)
            if blocked:
                sys.exit("waiting for " + ", ".join(blocked))
            deps = {dep: through[dep] for dep in dependencies(member) if dep in through and through[dep].get("revision")}
            earlier = earlier_commits(name, posts)
            scope = assignment_scope(member)
            import verify  # late: verify.py imports this module
            # A merge may take long (a large repository, hooks): every other board command runs meanwhile, and the
            # record is written to the board as it stands once the lock is back. One sync a member at a time: a second
            # would merge into the same checkout and write its own, older, list of what was merged over this one's.
            syncing = open(os.path.join(d, ".sync-%s.lock" % name), "w")  # held until this command ends
            try:
                fcntl.flock(syncing, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                sys.exit("another sync for @%s is still running: wait for it, then sync again" % name)
            agent = member.get("id")
            fcntl.flock(lock, fcntl.LOCK_UN)
            here = os.getcwd()
            head = verify.git(here, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
            if head is None:
                sys.exit("HEAD is no commit here: run `sync` from your checkout")
            # A merge belongs in the member's own worktree: run from the project, it would land on the user's branch.
            if verify.toplevel(here) == verify.toplevel(os.path.dirname(os.path.dirname(os.path.abspath(d)))) and not args[1:]:
                sys.exit("this is the project's own checkout, not your worktree: run `sync` from the worktree you work in")
            # Said here, before the member builds on it: `ready` would refuse the commit only once the work was done.
            base_commit = project_base(d, here)
            held = carried(here, member, members, posts, head.decode().strip(), base_commit)
            if held:
                sys.exit("HEAD still holds @%s's commit %s, which had not passed when @%s was retired: `ready` will refuse a "
                         "commit built on it. Rebuild your branch without it before you go on" % (held[0], held[1][:12], held[0]))
            behind = unmerged(here, deps, head.decode().strip())
            if args[1:]:
                for dep in behind:
                    print("unmerged: @%s %s (READY #%d)" % (dep, deps[dep]["revision"], deps[dep]["seq"]))
                if behind:
                    sys.exit(1)
                print("in sync: HEAD contains every dependency's READY commit")
                return
            for dep in behind:  # before the first merge: a dependency's commit may hold what HEAD does not
                held = carried(here, member, members, posts, deps[dep]["revision"], base_commit)
                if held:
                    sys.exit("@%s's commit %s holds @%s's commit %s, which had not passed when @%s was retired: `ready` would "
                             "refuse a commit built on it. Nothing was merged; ask @%s to rebuild without it"
                             % (dep, deps[dep]["revision"][:12], held[0], held[1][:12], held[0], dep))
            if behind:
                checkout_head("a merge would mix them into its commit", "")
            # Where this checkout's branch began, before anything is merged: a later READY reports the work from there.
            start = fresh(here, checkout_start(here), earlier)
            synced = {dep: post["revision"] for dep, post in deps.items() if dep not in behind}
            try:
                for dep in behind:
                    try:
                        verify.git(here, "merge", "--no-autostash", "--no-edit", "--no-ff", deps[dep]["revision"])
                    except ValueError as error:
                        verify.git(here, "merge", "--abort", optional=True)
                        if verify.git(here, "rev-parse", "-q", "--verify", "MERGE_HEAD", optional=True) is not None:
                            sys.exit("merging @%s's commit %s failed and git could not abort it: %s. The checkout is in the "
                                     "middle of that merge: finish it or run `git merge --abort`, then sync again"
                                     % (dep, deps[dep]["revision"][:12], error))
                        sys.exit("merging @%s's commit %s failed, so it was aborted: %s. If it conflicts, resolve it with @%s "
                                 "on the board or merge it yourself; if Git asks for an identity or a signing key, configure "
                                 "it for this repository. Then sync again" % (dep, deps[dep]["revision"][:12], error, dep))
                    synced[dep] = deps[dep]["revision"]
                    print("merged @%s's commit %s" % (dep, deps[dep]["revision"][:12]))
            finally:  # merges made before one failed are in the checkout, so the record holds them too
                state, posts = relocked()
                members = state["members"]
                member = members[name]
                # Written for the agent that merged, in its checkout: one put in its place meanwhile works elsewhere.
                # Added to what earlier syncs merged: after a merge that failed, their commits are in HEAD all the same.
                had = member.get("synced_deps") if isinstance(member.get("synced_deps"), dict) else {}
                record = {**had, **synced}
                if member.get("id") == agent and not member.get("killed") and (
                        member.get("synced_deps") != record or (start and member.get("start") != start)):
                    member["synced_deps"] = record
                    if start:
                        member["start"] = start
                    save(d, state)
            if (member.get("killed") or member.get("role") != "worker" or assignment_scope(member) != scope
                    or member.get("id") != agent):
                sys.exit("@%s's assignment changed while sync ran. The merges it made are in the checkout and recorded: "
                         "read the board and check them against the new assignment before you report" % name)
            now = readiness(members, posts)
            moved = [dep for dep, revision in synced.items() if now.get(dep, {}).get("revision") != revision]
            if moved:  # reported again, or withdrawn, while the merge ran
                print("note: %s changed while sync ran, so HEAD may not hold the READY commit now on the board: "
                      "sync again" % ", ".join("@" + dep for dep in moved))
            print("in sync: HEAD contains every dependency's READY commit" if not behind else
                  "synced: check the merged work, then report with ready %s HEAD" % name)

        elif cmd == "confirm":
            name = known(args[0])
            member = members[name]
            if state.get("closed") or member.get("role") != "worker" or member.get("killed") or kind_of(member) != "investigator":
                sys.exit("only findings from active investigators on an open run can be confirmed")
            latest = latest_reports(posts).get(name, {})
            if latest.get("kind") != "finding" or str(latest["seq"]) != args[1]:
                sys.exit("only the investigator's latest unconfirmed finding can be confirmed")
            through = readiness(members, posts)
            if unmet(member, members, through, latest["seq"]) or any(through[dep]["seq"] > latest["seq"] for dep in dependencies(member) if dep in through):
                sys.exit("the finding's prerequisites changed; ask for an updated finding")
            recipients = [dep for dep, entry in team_of(members).items() if name in dependencies(entry) or entry.get("role") == "verifier"]
            post_message(COORDINATOR, "READY %s\nConfirmed %s's finding #%d. Read it with show --post=%d (or the board tool's show action with seq: %d)."
                         % (name, name, latest["seq"], latest["seq"], latest["seq"]), recipients, kind="ready", subject=name, revision=None)
            run_plan(COORDINATOR)  # a confirmed finding may be the report that completes the team

        elif cmd == "read":
            # A reader pays in full only for posts addressed to it; the rest of the board costs it a line each.
            headers, everything = "--headers" in args, "--all" in args
            readers = [a for a in args if not a.startswith("--")]
            limits = [a for a in args if a.startswith("--max-bytes=")]
            attend = "--attention" in args
            if (headers and everything) or len(readers) != 1 or len(limits) > 1 or len(set(args)) != len(args) or set(args) - {*readers, *limits, "--headers", "--all", "--attention"}:
                sys.exit("read requires one member and accepts --all, --headers, --max-bytes=N or --attention")
            if limits and not re.fullmatch(r"--max-bytes=[0-9]{1,9}", limits[0]):
                sys.exit("--max-bytes must be between 256 and 1000000")
            maximum = int(limits[0].partition("=")[2]) if limits else None
            if maximum is not None and not 256 <= maximum <= 1_000_000:
                sys.exit("--max-bytes must be between 256 and 1000000")
            me = known(readers[0])
            if attend and me != COORDINATOR:
                sys.exit("--attention is for the coordinator only")
            new = [p for p in posts if p["seq"] > members[me]["last_read_seq"]]
            latest, role, deps = latest_reports(posts), members[me].get("role"), dependencies(members[me])
            current = readiness(members, posts)

            def needed(p):
                """A READY that counts now and the reader works from: a dependency's for a worker, any worker's for a
                verifier. Withheld from its `to` until it could act, the reader would otherwise pay a show for each.
                One a NOT PASSED rejected, a retired member's, or one whose own dependencies fell back is no work to
                build on."""
                subject = p.get("subject", p["agent"])
                if p.get("kind") != "ready" or current.get(subject) is not p:
                    return False
                if role == "verifier":
                    return members.get(subject, {}).get("role") == "worker" and members[subject].get("consult") != "1"
                return role == "worker" and subject in deps

            reader = members[me]
            delivered = set(reader.get("delivered", []))
            # A needed READY shown only in part: never delivered in full, but its start is not printed again either,
            # since the cut already says to show the whole post.
            clipped = set(reader.get("clipped", []))

            def passed_on(p):
                """A worker's READY the coordinator need not hold in full, where it is re-read at every step: someone
                else reviews it, and it asks nothing and names the coordinator nowhere, as a report needing a decision does."""
                subject = p.get("subject", p["agent"])
                return (p.get("kind") == "ready" and p["agent"] != COORDINATOR and members.get(p["agent"], {}).get("consult") != "1"
                        and not asks(p["text"]) and COORDINATOR not in mentions(p["text"])
                        and any(e.get("role") == "verifier" or subject in dependencies(e) for e in team_of(members).values()))
            # A needed READY the reader passed without its body: registered or replaced after it, given the
            # dependency later, or read with --headers or as a summary. Each is shown in full once.
            replay = [] if headers else [p for p in posts if p["seq"] <= reader["last_read_seq"]
                                         and p["seq"] not in delivered | clipped and needed(p)]
            printed = size = 0

            def fit(output, seq):
                """OUTPUT as it fits the page, or None once the page is full."""
                nonlocal size
                if maximum is None:
                    return output
                size += len(output.encode("utf-8")) + 1
                if size > maximum and printed:
                    return None
                if size > maximum:
                    # One post longer than a page would block every later read: its start is shown and the cursor moves on.
                    note = "\n  [cut to fit the page. The whole post: show --post=%d]\n" % seq
                    output = output.encode("utf-8")[:maximum - len(note.encode("utf-8")) - 1].decode("utf-8", "ignore") + note
                return output

            def say(line):  # a status line, counted so the attention block knows what room is left
                nonlocal size
                size += len(line.encode("utf-8")) + 1
                print(line)

            for p in replay:
                whole = show(p)
                output = fit(whole, p["seq"])
                if output is None:
                    break
                print(output)
                printed += 1
                (delivered if output == whole else clipped).add(p["seq"])
            replayed, emitted = printed, 0
            for p in new:  # a page the replay filled takes none of them: `size` is already past it
                mine, full = me in p["to"], needed(p) and not headers
                routine = me == COORDINATOR and not (everything or headers) and passed_on(p)
                if headers or routine or not (mine or everything or full):
                    lines = p["text"].split("\n")
                    word = REPORT_WORD.match(p["text"])
                    summary = " | ".join(lines[:2 if p.get("kind") or (word and word[1] == "BRIEF") else 1])
                    summary = summary[:SUMMARY_CHARS] + "…" if len(summary) > SUMMARY_CHARS else summary
                    p = dict(p, text=summary + (" [full: show --post=%d]" % p["seq"] if routine else ""))
                whole = ("* " if mine and not routine else "") + show(p)
                output = fit(whole, p["seq"])
                if output is None:
                    break
                print(output)
                printed += 1
                emitted += 1
                if full:
                    (delivered if output == whole else clipped).add(p["seq"])
            remaining = len(replay) - replayed + len(new) - emitted
            if replayed:
                say(f"{replayed} earlier report(s) you work from, shown in full")
            if replayed == len(replay):
                layout = ("one line per post" if headers else "all posts are shown in full" if everything else
                          "posts marked * mention you and are shown in full")
                say(f"{emitted} new post(s); {layout}" if emitted else
                    f"{remaining} new post(s) deferred to next page" if remaining else "no new posts")
            if remaining:
                say(f"{remaining} more post(s) remain. Read again for the next page.")
            sys.stdout.flush()
            # Kept to the posts that are still some subject's latest report: a replaced one is never needed again.
            changed = False
            for key, seqs in (("delivered", delivered), ("clipped", clipped - delivered)):
                seqs = sorted(seqs & {p["seq"] for p in latest.values()})
                if seqs != reader.get(key, []):
                    if seqs:
                        reader[key] = seqs
                    else:
                        reader.pop(key, None)
                    changed = True
            if emitted:
                reader["last_read_seq"] = new[emitted - 1]["seq"]
                progress(state, reader)
            # A member that has read what it was woken for is reachable and attentive: both counts start again.
            done = [key for key in ("wake_claim", "told") if key in reader and (
                reader[key].get("seq", 0) <= reader["last_read_seq"] or not unread(me))]
            for key in done:
                del reader[key]
            if emitted or done or changed:
                save(d, state)
            if attend and not remaining:  # after the cursor moved, so what was just read is not listed as unread
                report = attention(state, posts)
                block = attention_text(report)
                if maximum is not None and size + len(block.encode("utf-8")) + 1 > maximum:
                    block = "%d item(s) need attention, too many for this page. Run: attention" % len(report["items"])
                print(block)

        elif cmd == "show":
            as_json = "--json" in args
            rest = [a for a in args if a != "--json"]
            if as_json and len(rest) == 1 and re.fullmatch(r"--before=[1-9][0-9]{0,8}", rest[0]):
                stop = min(len(posts), int(rest[0].partition("=")[2]) - 1)
                page, size = [], 0
                for post in reversed(posts[max(0, stop - 12):stop]):
                    line = json.dumps(post, ensure_ascii=False)
                    size += len(line.encode("utf-8")) + 1
                    if page and size > 60_000:
                        break
                    page.append(line)
                print("\n".join(reversed(page)))
                return
            if len(rest) > 1 or (as_json and not (rest and re.fullmatch(r"--post=[0-9]{1,9}", rest[0]))):
                sys.exit("show takes a member name, --post=N [--json], or --before=N --json")
            who = rest[0].lstrip("@").lower() if rest else None
            if who and not re.fullmatch(r"--post=[0-9]{1,9}", who) and who not in members:
                sys.exit("show takes a member name or --post=N; members: %s" % " ".join("@" + n for n in members))
            if who and who.startswith("--post="):
                seq = int(who.partition("=")[2])
                if not 1 <= seq <= len(posts):
                    sys.exit("no post with that sequence")
                print(json.dumps(posts[seq - 1]) if as_json else show(posts[seq - 1]))
                return
            for p in posts:
                if who is None or who == p["agent"] or who in p["to"]:
                    print(show(p))

        elif cmd == "wake":
            ready = readiness(members, posts)
            for name, member in members.items():
                owed = unwoken(name)
                # A member not yet started is started once it can act: one started early idles past its cache.
                if name != COORDINATOR and waiting(member) and owed and (member.get("id") or runnable(name, members, posts, ready)):
                    claim = member.get("wake_claim", {})
                    exhausted = claim.get("attempts", 0) >= WAKE_ATTEMPTS and claim.get("until", 0) <= time.time()
                    suffix = " (attempts exhausted)" if exhausted else ""
                    print("@%s %s through #%d%s" % (name, member.get("id") or "NOT-SPAWNED", owed[-1], suffix))

        elif cmd == "claim":
            name = known(args[0])
            member = members[name]
            if not re.fullmatch(r"[0-9]{1,9}", args[2]):
                return
            seq = int(args[2])
            previous = member.get("wake_claim", {})
            now = time.time()
            if (name == COORDINATOR or not waiting(member) or member.get("id") != args[1]
                    or seq not in unwoken(name) or previous.get("until", 0) > now):
                return
            # Failed attempts belong to the member, not to one post: a newer mention does not start the count
            # again, or a member that cannot be reached would never be reported while posts keep arriving.
            # A delivered wake (`woke`) or `retry` clears them.
            attempts = previous.get("attempts", 0)
            if attempts >= WAKE_ATTEMPTS:
                if previous.get("seq") != seq:  # still unreachable, now for the newest mention
                    member["wake_claim"] = dict(previous, seq=seq)
                    save(d, state)
                return
            token = uuid.uuid4().hex
            member["wake_claim"] = {"token": token, "seq": seq, "attempts": attempts + 1,
                                    "until": now + WAKE_LEASE_SECONDS}
            save(d, state)
            print(token)

        elif cmd == "woke":
            if state.get("closed"):
                return
            name = known(args[0])
            member = members[name]
            if member.get("killed"):
                sys.exit(f"@{name} has been retired")
            if not re.fullmatch(r"[0-9]{1,9}", args[1]):
                sys.exit("wake claim no longer matches")
            seq = int(args[1])
            claim = member.get("wake_claim", {})
            if claim.get("token") != args[2] or claim.get("seq") != seq:
                sys.exit("wake claim no longer matches")
            member["last_nudged_seq"] = max(seq, member.get("last_nudged_seq", 0))
            member.pop("wake_claim")
            # Wakes count across mentions until the member reads: a newer mention must not start the count again.
            member["told"] = {"seq": seq, "at": time.time(), "times": member.get("told", {}).get("times", 0) + 1}
            save(d, state)

        elif cmd == "rearm":  # an agent's turn ended: a wake it did not answer with a read is owed again
            if state.get("closed"):
                return
            if not re.fullmatch(r"[0-9]{1,15}", args[0]):
                sys.exit("turn duration must be a non-negative integer in milliseconds")
            duration = int(args[0])
            started = time.time() - duration / 1000
            changed = False
            for name, member in members.items():
                if (member.get("killed") or member.get("paused") or member.get("id") not in args[1:] or not unread(name) or unwoken(name)
                        or ignored(name, members, posts)):
                    continue
                told = member.get("told", {})
                # A wake that landed while this turn ran is still queued and starts the next one, so it is not
                # owed again yet. Whether it landed before or during the turn is a comparison of two clocks
                # and can be wrong by a moment, so a second turn that ends with the mention still unread is
                # owed the wake whatever the clocks say: the doubt costs one turn at most, never the wake.
                if told.get("at", 0) <= started or told.get("ended"):
                    member.pop("last_nudged_seq", None)
                    told.pop("ended", None)
                else:
                    told["ended"] = True
                if told:
                    member["told"] = told
                changed = True
            if changed:
                save(d, state)

        elif cmd == "bind":
            path = binding_file(os.path.dirname(os.path.abspath(d)), args[0])
            if not RUN_NAME.fullmatch(os.path.basename(os.path.abspath(d))):
                sys.exit("invalid run folder")
            if state.get("binding") not in (None, args[0]):
                sys.exit("another conversation owns this run")
            if state.get("closed"):
                if state.get("binding") != args[0]:
                    sys.exit("the run is closed")
                # Still this conversation's, and nothing to restore: the pointer goes on naming its open run.
                print(os.path.abspath(d))
                return
            state["binding"] = args[0]
            save(d, state)
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            atomic_write(path, os.path.basename(os.path.abspath(d)) + "\n")
            print(os.path.abspath(d))

        elif cmd == "resume" and args:  # one member stopped by its own budget
            name = known(args[0])
            member = members[name]
            if not member.get("paused"):
                sys.exit("@%s is not paused" % name)
            used, own = state.get("usage", {}).get("tokens", {}).get(usage_key(member), 0), member_budget(state, member)
            if own and used >= own:
                sys.exit("@%s has used %s of its %s tokens. Raise it first: member %s budget=<tokens>"
                         % (name, f"{used:,}", f"{own:,}", name))
            del member["paused"]
            # Its tool calls were refused, so it stopped mid-work with nothing unread to wake it for.
            return post_message(COORDINATOR, "@%s Your token budget pause is lifted. Go on from where it stopped you." % name,
                                [name], save_roster=True)

        elif cmd in {"pause", "resume"}:
            if cmd == "pause":
                state["paused"] = " ".join(args).strip() or "awaiting coordinator"
            else:
                if over_budget:
                    sys.exit(f"token budget spent ({total} of {budget}); raise it with limit before resuming")
                # A pause refuses a member's next tool call, so one in the middle of its work ended its turn there
                # and nothing addresses it. Only those are told: a member that is ready, blocked, waiting for a
                # confirmation or an answer, or already owed a wake needs no turn.
                ready, reports = readiness(members, posts), latest_reports(posts)
                asking = {asker for _, asker, _ in unanswered(members, posts)}
                verified_seq = max((p["seq"] for p in posts if members.get(p["agent"], {}).get("role") == "verifier"
                                    and (w := REPORT_WORD.match(p["text"])) and w[1] in {"VERIFIED", "NOT PASSED", "NOT VERIFIED"}
                                    and not (w[1] == "VERIFIED" and p.get("partial"))), default=0)  # a partial pass is not the run's
                # A verifier is told of the work once every worker is ready (see `ready`): before that it was not
                # reviewing anything a pause could have stopped.
                unverified = any(p["seq"] > verified_seq for n, p in ready.items() if members.get(n, {}).get("consult") != "1") and all(
                    name in ready for name, entry in team_of(members).items() if entry.get("role") == "worker" and entry.get("consult") != "1")
                # A candidate, partial ones included, whose reports are all still current: a verifier asked to test it
                # that has posted no verdict on it was stopped in the middle of that review.
                try:
                    with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
                        candidate = json.load(f)
                except (OSError, ValueError):
                    candidate = None
                live = (isinstance(candidate, dict) and not candidate.get("accepted") and isinstance(candidate.get("inputs"), dict)
                        and all(isinstance(seen, list) and seen and ready.get(n, {}).get("seq") == seen[0]
                                for n, seen in candidate["inputs"].items()))

                def reviewing(name):  # answered only by a verdict after the latest request: a re-test is asked anew
                    tested = str(candidate.get("candidate")) if live else None
                    # A request to test it, as `answered` reads one: a note that only mentions the candidate asks nothing.
                    asked = max((p["seq"] for p in posts if tested and name in p["to"] and tested in p["text"]
                                 and REQUEST.search(p["text"])), default=0)
                    return bool(asked) and not any(
                        p["seq"] > asked and p["agent"] == name and (w := REPORT_WORD.match(p["text"]))
                        and w[1] in {"VERIFIED", "NOT PASSED", "NOT VERIFIED"}
                        and (p.get("candidate") == tested or tested in p["text"].split("\n")[0])
                        # a NOT PASSED of workers this candidate does not hold leaves its review unfinished
                        and (not p.get("rejects") or set(p["rejects"]) & set(candidate["inputs"])) for p in posts)

                halted = [name for name, member in team_of(members).items() if member.get("id") and not member.get("paused")
                          and name not in asking and (
                    (member.get("role") == "worker" and name not in ready and not unmet(member, members, ready)
                     and reports.get(name, {}).get("kind") != "finding" and (not unread(name) or bool(member.get("told", {}).get("ended"))))
                    or (member.get("role") == "verifier" and (bool(member.get("told", {}).get("ended"))
                                                              or (not unread(name) and (unverified or reviewing(name)))))
                )]
                if state.pop("paused", None) and halted:
                    return post_message(COORDINATOR, "%s The run is resumed. Go on from where the pause stopped you."
                                        % " ".join("@" + name for name in halted), halted, save_roster=True)
            save(d, state)

        elif cmd == "kill":  # the user's stop: no precondition, since whatever is open is what the user wants ended
            # `close` retires nobody, so a closed run may still have members at work: they are retired, and the closed
            # board gets no post.
            closed = state.get("closed")
            retired = [name for name, member in members.items() if name != COORDINATOR and not member.get("killed")]
            if closed and not retired:
                print("already closed")
                return
            if not closed:
                judge_last_pass()  # before the members are retired, while the pass is judged as on an open run
            reason = " ".join(args).strip() or "killed by the user"
            for name in retired:
                # The id and the rest stay, so the hooks still know each agent and refuse its tool calls.
                members[name]["killed"] = "1"
                for key in ("wake_claim", "told", "last_nudged_seq", "paused"):
                    members[name].pop(key, None)
            state["closed"] = True
            state.setdefault("killed", reason)
            state.pop("paused", None)
            if closed:
                save(d, state)
            else:
                post = {"seq": len(posts) + 1, "agent": COORDINATOR, "text": "SHUTDOWN\nThe user killed the run: " + reason,
                        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "to": []}
                members[COORDINATOR]["last_read_seq"] = post["seq"]  # nothing is owed on a run nobody will read again
                state["pending_post"] = post  # roster and post land together, as in `replace`
                save(d, state)
                append_post(d, post)
                del state["pending_post"]
                save(d, state)
            print("killed: %d member(s) retired, run closed" % len(retired))
            for name in retired:
                if members[name].get("id"):
                    print("@%s %s" % (name, members[name]["id"]))

        elif cmd == "close":
            owed = unread(COORDINATOR)
            if owed:
                sys.exit("@coordinator has not read %d post(s) addressed to it, from #%d on. Run: read coordinator, then close"
                         % (len(owed), owed[0]))
            candidate, stale = judge_last_pass()
            state["closed"] = True
            state.pop("paused", None)
            save(d, state)
            if stale:
                print("note: the last candidate, %s, passed earlier, now stale: %s. It is not the run's pass and was never "
                      "accepted" % (candidate.get("candidate"), stale))
            elif isinstance(candidate, dict) and candidate.get("verified_by") and candidate.get("partial"):
                print("note: the last candidate, %s, passed but was partial: it held only %s, so it is not the run's pass "
                      "and was never accepted" %(candidate.get("candidate"), ", ".join("@" + n for n in candidate.get("members", []))))
            elif isinstance(candidate, dict) and candidate.get("verified_by") and not candidate.get("accepted"):
                print("note: candidate %s passed verification and was never accepted, so the project does not hold it. "
                      "If the work went out another way (pull requests from the members' branches), `prune` removes its checkout"
                      % candidate.get("candidate"))

        elif cmd == "export":
            outs = [a.partition("=")[2] for a in args if a.startswith("--out=")]
            if len(outs) != len(args) or (outs and not outs[0]):
                sys.exit("export accepts only --out=PATH")
            path = os.path.abspath(outs[0] if outs else os.path.join(d, "summary.md"))
            ready, tokens = readiness(members, posts), state.get("usage", {}).get("tokens", {})

            def cell(value):
                return str(value).replace("|", "\\|").replace("\n", " ") or "-"

            lines = ["# " + state["title"], "",
                     "Status: %s. %d posts." % ("closed" if state.get("closed") else "paused: " + state["paused"]
                                                if state.get("paused") else "open", len(posts)), "", "## Team", "",
                     "| Member | Type | Model | Effort | Owns | Ready | Tokens |", "| --- | --- | --- | --- | --- | --- | --- |"]
            authors = {post["agent"] for post in posts}
            for name, member in members.items():
                if name != COORDINATOR:
                    # Seen live: members registered and never spawned read as unfinished work with a plain "no".
                    lines.append("| %s |" % " | ".join(cell(v) for v in (
                        "@" + name + (" (retired)" if member.get("killed") else " (paused)" if member.get("paused") else ""),
                        kind_of(member), model_of(member), effort_of(member), member.get("owns") or member.get("paths", ""),
                        "yes" if name in ready else "no" if member.get("id") or name in authors else "not started",
                        f"{tokens.get(usage_key(member), 0):,}")))
            lines += ["", "Tokens: %s in all%s, %s of them the coordinator's." % (
                f"{total:,}", " of a %s budget" % f"{budget:,}" if budget else "", f"{tokens.get(COORDINATOR, 0):,}"),
                ""]
            detail = state.get("usage", {}).get("detail", {})
            if detail:
                # Unweighted, by what started the turn: the table that says which wakes are worth avoiding.
                lines += ["## Usage", "", "| Member | Type | Wake | %s |" % " | ".join(DETAIL_COLUMNS), "| --- " * 8 + "|"]
                for name, member in members.items():
                    key = COORDINATOR if name == COORDINATOR else usage_key(member)
                    for wake, row in sorted(detail.get(key, {}).items()):
                        lines.append("| %s |" % " | ".join(cell(v) for v in (
                            "@" + name, "coordinator" if name == COORDINATOR else kind_of(member), wake, *(f"{n:,}" for n in row))))
                lines.append("")
            lines += ["## Verification", ""]
            try:
                with open(os.path.join(d, "verification.json"), encoding="utf-8") as f:
                    candidate = json.load(f)
            except (OSError, ValueError):
                candidate = None
            if isinstance(candidate, dict):
                passed = candidate.get("verified_by") and not candidate.get("accepted")
                stale = passed and stale_pass(d, candidate, bool(state.get("closed")))
                lines.append("Candidate %s (%s%s), %s: %s." % (
                    candidate.get("candidate"), candidate.get("mode"),
                    ", partial: " + ", ".join("@" + n for n in candidate.get("members", [])) if candidate.get("partial") else "",
                    candidate.get("commit") or candidate.get("digest"),
                    "accepted" if candidate.get("accepted") else
                    "passed earlier, now stale: %s; verified by @%s" % (stale, candidate["verified_by"]) if stale else
                    "passed, verified by @%s" % candidate["verified_by"] if passed else "not passed"))
                if candidate.get("allowed"):
                    lines.append("The coordinator allowed these past the diff guards: %s." % "; ".join(map(str, candidate["allowed"])))
                if candidate.get("waived"):
                    lines.append("Waived as failing on the base in the same way: %s." % "; ".join(map(str, candidate["waived"])))
            else:
                lines.append("No candidate was prepared.")
            lines += ["", "## Transcript", ""]
            for p in posts:
                lines += ["### #%d %s @%s -> %s" % (p["seq"], p["time"].replace("T", " ")[:19], p["agent"],
                                                    " ".join("@" + t for t in p["to"]) or "-"), ""]
                lines += ["> " + line if line else ">" for line in p["text"].split("\n")] + [""]
            atomic_write(path, "\n".join(lines))
            print(path)

        elif cmd == "status":
            status = " (closed)" if state.get("closed") else " (paused)" if state.get("paused") else ""
            print("%s: %d posts%s" % (state["title"], len(posts), status))
            if total or budget:
                amount = f"{total} of {budget}" if budget else str(total)
                print(f"Usage: {amount} tokens")
            for name, m in members.items():
                mine = [p["seq"] for p in posts if p["agent"] == name]
                extra = " ".join("%s=%s" % kv for kv in m.items() if not kv[0].startswith("last_") and kv[0] not in {"wake_claim", "told", "synced_deps", "start", "tested", "delivered", "clipped"})
                print("  @%-14s last post %-5s unread mentions %d  %s" % (name, "#%d" % mine[-1] if mine else "-", len(unread(name)), extra))
            edges = Counter((p["agent"], n) for p in posts for n in p["to"])
            for (a, b), count in edges.most_common():
                print("  @%s -> @%s x%d" % (a, b, count))

        else:
            sys.exit(USAGE)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"board: {error}")

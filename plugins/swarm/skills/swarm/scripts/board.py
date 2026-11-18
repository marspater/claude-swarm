#!/usr/bin/env python3
"""Shared message board for a swarm: numbered posts, @mentions, unread cursors.

usage: board.py DIR init TITLE                    prints the run folder it created; use that as DIR from then on
       board.py DIR member NAME [key=value ...]   add or update (role= profile= group= depends= owns= model= effort= id= killed=1)
       board.py DIR limit [key=value ...]         set run limits: max_workers= max_members= budget=<tokens> <model>=<types>
       board.py DIR plan                          the team as a table: type, model, effort, dependencies, ownership
       board.py DIR attention [--json]            what needs someone: unanswered questions, blocked or unreachable members, stale verification
       board.py DIR retry NAME                    let delivery try an unreachable or unresponsive member again
       board.py DIR replace OLD NEW [key=value ...]  retire OLD and register NEW with its brief, dependencies and history
       board.py DIR post FROM [TEXT]              TEXT from stdin when omitted
       board.py DIR read ME                       print posts ME has not read, mark them read: posts that mention ME in full, others as one line
       board.py DIR read ME --all                 the same, every post in full
       board.py DIR read ME --headers             the same, every post as one line
       board.py DIR read ME --max-bytes=N          page the unread output without consuming the next unread post
       board.py DIR show [NAME | --post=N]        print history, optionally for one member or post; marks nothing
       board.py DIR ready NAME [COMMIT]           record readiness and notify coordinator, verifiers and dependents
       board.py PARENT adopt KEY NAME             bind the newest open, unowned run that registers NAME; prints its folder
       board.py DIR confirm NAME SEQ              accept an investigator finding and release its dependents
       board.py DIR revise NAME [REASON]           withdraw readiness before starting a fix
       board.py DIR wake                          list pending wakes, including the post sequence
       board.py DIR claim NAME ID SEQ             claim delivery through SEQ and print its token
       board.py DIR woke NAME SEQ TOKEN           acknowledge a successful delivery
       board.py DIR rearm TURN_MS ID...           after agent ID's turn of TURN_MS: wake it again for mentions it left unread
       board.py DIR pause [REASON]                 pause automation while awaiting a decision
       board.py DIR resume                         resume automation
       board.py DIR bind KEY                       bind this run to a private lookup key
       board.py .swarm restore KEY                 find the run for a private lookup key
       board.py .swarm adopt KEY NAME [HINT]       bind the one open run that has member NAME; exit 3 when it cannot tell which, 4 when an open run lacks the member
       board.py DIR close                         mark the run finished
       board.py DIR account TURN_HASH ACTOR_KEY TOKENS  record a completed turn once
       board.py DIR status                        members, unread counts, who mentioned whom
       board.py DIR tail [BYTES]                  the newest whole posts of board.jsonl within BYTES (default 3000000), raw

`init` takes <project>/.swarm/<name> and creates <project>/.swarm/<name>-<timestamp>, so every
run has its own folder. A run folder holds board.jsonl, one {"seq","agent","text","time","to"}
per line, and members.json: {"title","closed","members":{name:{role,group,model,id,
last_read_seq,last_nudged_seq,killed}}}.
"""
import fcntl  # ponytail: POSIX only; swap in msvcrt.locking if Windows support is needed
import json
import os
import re
import sys
import tempfile
import time
import uuid
from collections import Counter

# The late `import verify` would otherwise write __pycache__ into the plugin folder, which may be read-only.
sys.dont_write_bytecode = True

# @name at a word start; an email or a path (a@b.com, pkg/@scope) is not a mention
MENTION = re.compile(r"(?<![\w.@/])@([A-Za-z][\w-]*)")
NAME = re.compile(r"[a-z](?:[a-z0-9_-]*[a-z0-9])?")  # ends in a letter or digit: "@name-" in prose is @name
COORDINATOR = "coordinator"
WAKE_LEASE_SECONDS = 15
WAKE_ATTEMPTS = 3
TURNS_KEPT = 2000
COMMIT = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
RUN_NAME = re.compile(r"[a-zA-Z0-9_.-]+-\d{8}-\d{6}x*")
BIND_KEY = re.compile(r"[a-f0-9]{64}")
# The first line says what a post is. Mentions before the word stay on that line: a word on line two is prose.
REPORT_WORD = re.compile(r"^(?:@[\w-]+[ \t,]*)*(READY|REVISE|BRIEF|SHUTDOWN|FINDING|VERIFIED|NOT (?:PASSED|VERIFIED))\b")
ARG_COUNTS = {
    "init": (1, None), "restore": (1, 1), "adopt": (2, None), "locate": (2, None),
    "agent-run": (2, 3), "started": (3, 3), "member": (1, None),
    "limit": (0, None), "plan": (0, 0), "attention": (0, 1), "retry": (1, 1),
    "replace": (2, None), "post": (1, None), "ready": (1, 2), "revise": (1, None),
    "confirm": (2, 2), "read": (1, 4), "show": (0, 1), "wake": (0, 0),
    "claim": (3, 3), "woke": (3, 3), "rearm": (2, None), "bind": (1, 1),
    "pause": (0, None), "resume": (0, 0), "close": (0, 0), "status": (0, 0), "account": (3, 3), "tail": (0, 1),
}
READ_COMMANDS = {"show", "status", "plan", "attention", "wake"}
USAGE = __doc__.split("\n\n")[1]


def atomic_write(path, value):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def save(d, state):
    atomic_write(os.path.join(d, "members.json"), json.dumps(state, indent=1))


def load_state(d):
    with open(os.path.join(d, "members.json"), encoding="utf-8") as f:
        state = json.load(f)
    members = state.get("members") if isinstance(state, dict) else None
    if not isinstance(members, dict) or COORDINATOR not in members or not isinstance(state.get("title"), str):
        raise ValueError("invalid swarm roster")
    return state


def load(d):
    state = load_state(d)
    path = os.path.join(d, "board.jsonl")
    posts = []
    try:
        f, writable = open(path, "rb+"), True
    except OSError:  # a read-only copy can still be shown; it is simply not repaired
        f, writable = open(path, "rb"), False
    with f:
        while line := f.readline():
            if not line.strip():
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
            if not isinstance(post, dict) or type(post.get("seq")) is not int or post["seq"] != len(posts) + 1 or not all(
                    isinstance(post.get(key), str) for key in ("agent", "text", "time")) or (
                    "to" in post and (not isinstance(post["to"], list) or not all(isinstance(name, str) for name in post["to"]))):
                raise ValueError(f"invalid board record after post #{len(posts)}")
            posts.append(post)
            if not line.endswith(b"\n") and writable:
                f.write(b"\n")
    pending = state.pop("pending_post", None)
    if pending is not None:
        # A replacement commits its roster and brief together. Recover after either interrupted write.
        if pending["seq"] == len(posts) + 1:
            append_post(d, pending)
            posts.append(pending)
        elif not posts or posts[-1] != pending:
            raise ValueError("a pending board update conflicts with the saved history")
        save(d, state)
    for post in posts:
        if "to" not in post:
            post["to"] = [name for name in targets(post["text"], state["members"]) if name != post["agent"]]
    return state, posts


def append_post(d, post):
    with open(os.path.join(d, "board.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(post) + "\n")


def dependencies(member):
    return member.get("depends", "").split(",") if member.get("depends") else []


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


def readiness(members, posts):
    ready = {}
    # Evaluate the latest reports in board order so prerequisites must still be current.
    for name, post in sorted(latest_reports(posts).items(), key=lambda entry: entry[1]["seq"]):
        member = members.get(name, {})
        if (post["kind"] == "ready" and member.get("role") == "worker" and not member.get("killed")
                and all(dep in ready for dep in dependencies(member))):
            ready[name] = post
    return ready


# The model and effort each agent type runs at unless the roster says otherwise.
DEFAULTS = {"worker": ("sonnet", "medium"), "verifier": ("opus", "high"), "explorer": ("haiku", "medium"),
            "investigator": ("opus", "high"), "architect": ("fable", "high"), "designer": ("opus", "high")}
# Specialists read and report through the board tool. A designer is a profile that writes files, like a worker.
READ_ONLY = {"explorer", "investigator", "architect"}
PROFILES = {*READ_ONLY, "designer"}
FAMILIES = ("haiku", "sonnet", "opus", "fable")
LIMITS = {"max_workers", "max_members", "budget", *FAMILIES}
INHERITED = ("role", "group", "profile", "writes", "depends", "owns", "model", "effort", "consult")
MEMBER_FIELDS = {*INHERITED, "backend", "id", "killed"}


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


def validate_member(name, member, changes, members):
    if "role" in changes and member["role"] not in ({COORDINATOR} if name == COORDINATOR else {"worker", "verifier"}):
        raise ValueError(f"invalid role for @{name}")
    if ("profile" in changes and member["profile"] not in {"", *PROFILES}) or (
            {"role", "profile"} & changes.keys() and member.get("profile") and member["role"] != "worker"):
        raise ValueError("specialist and designer profiles belong to workers")
    if name == COORDINATOR and changes.keys() - {"backend", "role", "id", "killed", "depends"}:
        raise ValueError("the coordinator is the conversation itself: only backend= can be set on it")
    if changes.get("group") not in (None, "", "-") and (not NAME.fullmatch(changes["group"]) or changes["group"] == "all" or changes["group"] in members):
        raise ValueError("a group name uses lowercase letters, digits and hyphens, and is neither 'all' nor a member's name")
    if "backend" in changes and (name != COORDINATOR or changes["backend"] not in {"", "native"}):
        raise ValueError("backend=native is only valid for the coordinator")
    if name == COORDINATOR and {"id", "killed", "depends"} & changes.keys():
        raise ValueError("the coordinator cannot be assigned an agent address, retired, or made dependent")
    if "killed" in changes and changes["killed"] != "1":
        raise ValueError("use killed=1 to retire a member, or replace to register a successor")
    for flag in ("writes", "consult"):
        if flag in changes and changes[flag] not in {"", "0", "1"}:
            raise ValueError(f"{flag} must be 0 or 1")
    if "effort" in changes and changes["effort"] not in {"", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError("effort must be low, medium, high, xhigh, or max")
    if member.get("profile") in READ_ONLY:
        if "profile" in changes and "writes" not in changes:
            member["writes"] = "0"
        if "writes" in changes and member.get("writes") != "0":
            raise ValueError("specialist profiles are read-only")
    if member.get("consult") == "1" and (kind_of(member) != "architect" or member.get("writes") != "0"):
        raise ValueError("consult=1 is only valid for a read-only architect")
    if "id" in changes and (not changes["id"] or any(c.isspace() for c in changes["id"]) or any(
            other != name and not entry.get("killed") and entry.get("id") == changes["id"] for other, entry in members.items())):
        raise ValueError("agent addresses must be nonempty and unique among active members")


def kind_of(member):
    """The agent type behind a member: its profile (a specialist or the designer), else its role."""
    return member.get("profile") or member.get("role", "worker")


def model_of(member):
    return member.get("model") or DEFAULTS.get(kind_of(member), ("", ""))[0]


def effort_of(member):
    return member.get("effort") or DEFAULTS.get(kind_of(member), ("", ""))[1]


def family(model):
    return next((name for name in FAMILIES if name in model.lower()), model)


def team_of(members):
    return {n: m for n, m in members.items() if n != COORDINATOR and not m.get("killed")}


def limit_errors(state):
    """Every way the roster breaks the run's limits, as sentences the coordinator can act on."""
    limits, team = state.get("limits", {}), team_of(state["members"])
    errors = []
    workers = [n for n, m in team.items() if m.get("role") != "verifier"]
    if "max_workers" in limits and len(workers) > int(limits["max_workers"]):
        errors.append("%d workers, but this run allows %s" % (len(workers), limits["max_workers"]))
    if "max_members" in limits and len(team) > int(limits["max_members"]):
        errors.append("%d members, but this run allows %s" % (len(team), limits["max_members"]))
    for name in FAMILIES:
        if name in limits:
            allowed = set(limits[name].split(",")) - {"none", ""}
            for member, entry in team.items():
                if family(model_of(entry)) == name and kind_of(entry) not in allowed and member not in allowed:
                    errors.append("@%s (%s) would run on %s, which this run allows only for: %s. Register it with another model="
                                  % (member, kind_of(entry), name, ", ".join(sorted(allowed)) or "nobody"))
    return errors


def unread_of(name, members, posts):
    return [p["seq"] for p in posts if p["seq"] > members[name]["last_read_seq"] and name in p["to"]]


def unwoken_of(name, members, posts):
    return [n for n in unread_of(name, members, posts) if n > members[name].get("last_nudged_seq", 0)]


def unreachable(name, members, posts):
    owed, claim = unwoken_of(name, members, posts), members[name].get("wake_claim", {})
    # The last attempt has its lease to succeed in before the member counts as unreachable.
    return (bool(owed) and claim.get("seq") == owed[-1] and claim.get("attempts", 0) >= WAKE_ATTEMPTS
            and claim.get("until", 0) <= time.time())


def ignored(name, members, posts):
    """Woken WAKE_ATTEMPTS times for the same post and still has not read it."""
    owed, told = unread_of(name, members, posts), members[name].get("told", {})
    return bool(owed) and told.get("seq") == owed[-1] and told.get("times", 0) >= WAKE_ATTEMPTS


def verified_line(d, verifier, first):
    """True when FIRST carries the line verify.py printed for the current candidate, passed by this verifier."""
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
    # A pass describes the sources and reports it ran on: a change since then voids it, accepted or not.
    import verify  # late: verify.py imports this module
    try:
        verify.check_current(verify.Path(d), candidate)
    except (ValueError, OSError, KeyError, TypeError) as error:
        sys.exit("that VERIFIED is void: %s. Post NOT VERIFIED or a note, and wait for a new candidate." % error)
    return True


def unanswered(members, posts):
    """Track pending questions per asker and recipient in board order."""
    pending = {}
    for post in posts:
        text = post["text"]
        if post.get("kind") or REPORT_WORD.match(text):
            continue
        sender = post["agent"]
        # "re #4", and every number of "re #4, #7 and #9"
        cited = [seq for run in re.findall(r"\bre\s+((?:#[0-9]+(?:\s*(?:,|and|&)\s*)?)+)", text, re.IGNORECASE)
                 for seq in re.findall(r"#([0-9]+)", run)]
        for recipient in post["to"]:
            pair = (recipient, sender)
            if cited:
                for seq in cited:
                    pending.get(pair, {}).pop(seq.lstrip("0"), None)
            else:
                pending.pop(pair, None)
            if "?" in text and recipient in members and not members[recipient].get("killed"):
                pending.setdefault((sender, recipient), {})[str(post["seq"])] = post["seq"]
    # A removed member is waiting for nothing: its questions close with it.
    return sorted((seq, asker, recipient) for (asker, recipient), seqs in pending.items() for seq in seqs.values()
                  if not members.get(asker, {}).get("killed"))


def attention(state, posts):
    """What needs someone, each item naming the post that shows it, and a view of every member."""
    members = state["members"]
    team, ready = team_of(members), readiness(members, posts)
    items, asked = [], {}
    if state.get("paused"):
        items.append({"kind": "paused", "member": COORDINATOR, "seq": 0, "text": "The run is paused: " + state["paused"]})
    if not state.get("closed"):
        owed = unread_of(COORDINATOR, members, posts)
        if owed:  # a coordinator that follows the run some other way leaves reports and questions unseen
            items.append({"kind": "unread", "member": COORDINATOR, "seq": owed[0],
                          "text": "@coordinator has not read %d post(s) addressed to it, from #%d on. Run: read coordinator" % (len(owed), owed[0])})
        for name, post in latest_reports(posts).items():
            if name in team and post.get("kind") == "finding":
                items.append({"kind": "review", "member": name, "seq": post["seq"],
                              "text": "@%s's finding needs the coordinator to review the evidence" % name})
    for seq, asker, recipient in unanswered(members, posts):
        items.append({"kind": "question", "member": recipient, "seq": seq,
                      "text": "@%s has not answered @%s" % (recipient, asker)})
        asked.setdefault(asker, seq)
    for name, member in team.items():  # briefed, but no agent: a spawn that never happened or was cut off
        owed = unwoken_of(name, members, posts)
        if not member.get("id") and owed:
            items.append({"kind": "unstarted", "member": name, "seq": owed[0],
                          "text": "@%s has a brief and no agent. Start it once and record its id" % name})
    for name in team:
        if unreachable(name, members, posts):
            items.append({"kind": "unreachable", "member": name, "seq": unwoken_of(name, members, posts)[-1],
                          "text": "@%s could not be woken after %d attempts. Retry it or replace it" % (name, WAKE_ATTEMPTS)})
    for name in team:
        if ignored(name, members, posts):
            items.append({"kind": "ignored", "member": name, "seq": unread_of(name, members, posts)[-1],
                          "text": "@%s was woken %d times and has not read its mentions. Run retry %s, or replace it" % (name, WAKE_ATTEMPTS, name)})
    for name, member in team.items():
        if name in ready:
            continue
        for dep in dependencies(member):
            upstream = members.get(dep, {})
            why = ("is missing" if not upstream else "was removed" if upstream.get("killed") else "is unreachable" if unreachable(dep, members, posts)
                   else "was never started" if "id" not in upstream and "id" in member else None)
            if why:
                last = [p["seq"] for p in posts if p["agent"] == dep]
                items.append({"kind": "blocked", "member": name, "seq": last[-1] if last else 0,
                              "text": "@%s waits for @%s, which %s" % (name, dep, why)})
    def passed(post):
        protocol = REPORT_WORD.match(post["text"])
        return members.get(post["agent"], {}).get("role") == "verifier" and protocol and protocol[1] == "VERIFIED"

    verified = [p for p in posts if passed(p)]
    if verified:
        changed = [p for p in posts if p["seq"] > verified[-1]["seq"] and p.get("kind") in {"ready", "revise"}
                   and members.get(p.get("subject", p["agent"]), {}).get("writes") != "0"]
        if changed:
            items.append({"kind": "stale", "member": verified[-1]["agent"], "seq": verified[-1]["seq"],
                          "text": "VERIFIED (#%d) is older than @%s's change (#%d)" % (verified[-1]["seq"], changed[0]["agent"], changed[0]["seq"])})
    if state.get("closed"):  # a finished run asks for nothing: what was left open is history
        items, asked = [], {}
    view = {name: {"type": kind_of(member), "model": model_of(member), "effort": effort_of(member),
                   "depends": dependencies(member), "owns": member.get("owns", ""), "ready": name in ready,
                   "blocked_on": [] if name in ready else [d for d in dependencies(member) if d not in ready],
                   "asked": asked.get(name, 0), "unreachable": name in team and unreachable(name, members, posts)}
            for name, member in members.items() if name != COORDINATOR}
    return {"items": items, "members": view, "limits": state.get("limits", {})}


def budget_usage(state):
    budget = int(state.get("limits", {}).get("budget", "0"))
    total = sum(state.get("usage", {}).get("tokens", {}).values())
    return budget, total


def account(d, args):
    if len(args) != 3:
        sys.exit("account requires a turn hash, an actor key, and a token count")
    turn, actor, count = args
    if not BIND_KEY.fullmatch(turn) or (actor != COORDINATOR and not BIND_KEY.fullmatch(actor)):
        sys.exit("invalid usage key")
    if not re.fullmatch(r"[1-9][0-9]{0,15}", count):
        sys.exit("expected a positive token count")
    state = load_state(d)
    usage = state.setdefault("usage", {})
    tokens = usage.setdefault("tokens", {})
    turns = usage.setdefault("turns", {})
    recorded = turn not in turns
    if recorded:
        turns[turn] = True
        tokens[actor] = tokens.get(actor, 0) + int(count)
        # Only a retried report repeats a turn, and it does so at once: the oldest entries are never asked about again.
        for old in list(turns)[:-TURNS_KEPT]:
            del turns[old]
    budget, total = budget_usage(state)
    paused = bool(budget and total >= budget and not state.get("paused") and not state.get("closed"))
    if paused:
        state["paused"] = f"token budget of {budget} spent"
    if recorded or paused:
        save(d, state)
    print(json.dumps({"title": state["title"], "total": total, "budget": budget, "paused": paused}))


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


def targets(text, members):
    """The names a post reaches: its @name, @group and @all mentions, expanded to live members."""
    # the name as written reaches a roster made before names had to end in a letter or digit
    mentioned = {form for m in MENTION.findall(text) for form in (m.lower(), m.lower().rstrip("-_"))}
    return [n for n, m in members.items() if not m.get("killed") and mentioned & {"all", n, m.get("group")}]


def show(post):
    head = "#%d %s @%s -> %s" % (post["seq"], post["time"][11:19], post["agent"], " ".join("@" + t for t in post["to"]) or "-")
    return head + "\n" + "\n".join("  " + line for line in post["text"].split("\n")) + "\n"


def init(d, title):
    parent, name = os.path.split(os.path.abspath(d))
    if os.path.basename(parent) != ".swarm":  # never write a "*" .gitignore anywhere else
        sys.exit("DIR must be <project>/.swarm/<swarm-name>")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", name) or not title.strip():
        sys.exit("init requires a run name using letters, digits, dots, underscores or hyphens, and a nonempty title")
    os.makedirs(parent, exist_ok=True)
    run = "%s-%s" % (name, time.strftime("%Y%m%d-%H%M%S"))
    while True:  # mkdir is atomic, so two runs started in the same second get two folders
        try:
            os.mkdir(os.path.join(parent, run))
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
    save(d, {"title": title, "members": {COORDINATOR: {"role": COORDINATOR, "last_read_seq": 0}}})
    atomic_write(os.path.join(parent, "current"), run + "\n")
    print(d)


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
                    with open(os.path.join(d, name, "members.json"), encoding="utf-8") as f:
                        saved = json.load(f)
                        if saved.get("binding") == args[0] and not saved.get("closed"):
                            print(os.path.abspath(os.path.join(d, name)))
                            return
                except (FileNotFoundError, ValueError):
                    pass
        # A crash can commit the roster before the private pointer is written.
        candidates = [name for name, state in saved_runs(d) if state.get("binding") == args[0] and not state.get("closed")]
        if len(candidates) == 1:
            print(os.path.abspath(os.path.join(d, candidates[0])))
        return
    if cmd == "agent-run":
        binding_file(d, args[0])
        matches = [name for name, state in saved_runs(d) if state.get("binding") == args[0] and any(
            member.get("id") in args[1:] for member in state["members"].values())]
        if len(matches) == 1:
            print(os.path.abspath(os.path.join(d, matches[0])))
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
            choosing = open(os.path.join(d, ".adopt.lock"), "w")
            fcntl.flock(choosing, fcntl.LOCK_EX)  # held until the process exits
        runs = list(saved_runs(d))
        mine, unowned, open_runs = [], [], 0
        for run, found in runs:
            member = found.get("members", {}).get(name)
            if not found.get("closed") and found.get("binding") in (None, key):
                open_runs += 1
            if found.get("closed") or not member or member.get("killed") or found.get("binding") not in (None, key):
                continue
            (unowned if found.get("binding") is None else mine).append(run)
        named = [run for run, _ in runs if re.search(r"(?<![\w.-])%s(?![\w.-])" % re.escape(run), hint)]
        if len(named) > 1 or (not named and len(mine or unowned) > 1):
            print("ambiguous: " + " ".join(unowned), file=sys.stderr)
            sys.exit(3)
        if named and named[0] not in mine + unowned:
            sys.exit(5)
        chosen = named[0] if len(named) == 1 else (mine + unowned)[0] if mine or unowned else None
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

    if cmd == "tail":
        # For a reader with a size limit (the pane reads at most 4 MiB): whole lines only, newest last. Takes no lock.
        if args and not re.fullmatch(r"[0-9]{1,9}", args[0]):
            sys.exit("tail takes a byte count")
        budget = int(args[0]) if args else 3_000_000
        with open(os.path.join(d, "board.jsonl"), "rb") as f:
            size = f.seek(0, os.SEEK_END)
            f.seek(max(0, size - budget))
            data = f.read()
        sys.stdout.buffer.write(data.partition(b"\n")[2] if size > budget else data)
        return

    try:
        lock = open(os.path.join(d, ".lock"), "w")
    except OSError:
        if cmd not in READ_COMMANDS:
            raise
        lock = open(os.path.join(d, "members.json"), "rb")  # a read-only folder can still be shown
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # released when the process exits
        if cmd == "account":
            return account(d, args)
        state, posts = load(d)
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
            if save_roster:
                state["pending_post"] = post
                save(d, state)
            append_post(d, post)
            if save_roster:
                del state["pending_post"]
                save(d, state)
            print("posted #%d -> %s" % (post["seq"], " ".join("@" + t for t in recipients) or "nobody"))
            owed = unread(sender)
            if owed:  # the one notice that reaches a member whatever started it and whatever hooks are loaded
                print("UNREAD: %d post(s) address @%s from #%d on. Read them now: read %s"
                      % (len(owed), sender, owed[0], sender))

        def waiting(member):
            return not state.get("closed") and not state.get("paused") and not over_budget and not member.get("killed")

        if cmd == "started":
            name = known(args[0])
            member = members[name]
            address, expected = args[1:]
            if member.get("killed") or name == COORDINATOR:
                sys.exit("the assignment is no longer active")
            validate_member(name, member, {"id": address}, members)
            if member.get("id") == address:
                return
            if member.get("id", "") != expected:
                sys.exit("the roster address changed while the agent was starting")
            for key in ("wake_claim", "last_nudged_seq", "told"):
                member.pop(key, None)
            member["id"] = address
            save(d, state)

        elif cmd == "member":
            name = args[0].lstrip("@").lower()
            # a member registered before names had to end in a letter or digit stays manageable
            if name not in members and (not NAME.fullmatch(name) or name == "all"):
                sys.exit("bad member name %r: use lowercase letters, digits and hyphens, ending in a letter or digit" % name)
            before = set(limit_errors(state))
            member = members.setdefault(name, {"role": "worker", "last_read_seq": len(posts)})
            changes = assignments(args[1:], MEMBER_FIELDS)
            if "id" in changes and changes["id"] != member.get("id"):
                for key in ("wake_claim", "last_nudged_seq", "told"):
                    member.pop(key, None)
            if member.get("profile") in READ_ONLY and changes.get("profile") == "designer" and "writes" not in changes:
                member.pop("writes", None)  # a specialist turned designer writes again unless told otherwise
            member.update(changes)
            validate_member(name, member, changes, members)
            if kind_of(member) == "investigator" and family(model_of(member)) == "fable" and "effort" in changes \
                    and not {"model", "profile"} & set(changes) and effort_of(member) != "medium":
                sys.exit("a Fable investigator runs at medium effort")
            if {"model", "profile"} & set(changes) and kind_of(member) == "investigator" and family(model_of(member)) == "fable":
                sys.exit("an investigator starts on Opus. Fable is the escalation after an Opus investigator fails: "
                         "board.py DIR replace OLD NEW model=fable effort=medium")
            if "depends" in changes:
                if any(dep not in members or members[dep].get("role") != "worker"
                       or members[dep].get("killed") for dep in dependencies(member)):
                    sys.exit("dependencies must be registered, active workers")
                frontier = dependencies(member)
                seen = set()
                while frontier:
                    dep = frontier.pop()
                    if dep == name:
                        sys.exit("dependency cycle")
                    if dep not in seen:
                        seen.add(dep)
                        frontier.extend(dependencies(members.get(dep, {})))
            errors = [error for error in limit_errors(state) if error not in before]
            if errors:
                sys.exit("over the run's limits, nothing was changed: " + "; ".join(errors))
            save(d, state)

        elif cmd == "limit":
            changes = assignments(args, LIMITS)
            if any(not re.fullmatch(r"[0-9]{1,15}", changes[k]) for k in changes if k in ("max_workers", "max_members", "budget")):
                sys.exit("limits are max_workers=N max_members=N budget=TOKENS and <model>=<types>, for models: " + " ".join(FAMILIES))
            for model in FAMILIES:
                for token in changes.get(model, "").split(","):
                    if token in {"", "none"} or token in DEFAULTS:
                        continue
                    if not NAME.fullmatch(token):
                        sys.exit("%s=%s: list agent types (%s), member names, or none" % (model, changes[model], ", ".join(DEFAULTS)))
                    if token not in members:  # a name registered later is fine; a typo would lock the model for everyone
                        print("note: %s=%s names no agent type and no member yet. Types are: %s" % (model, token, ", ".join(DEFAULTS)))
            state.setdefault("limits", {}).update(changes)
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
                                                           ",".join(dependencies(member)) or "-", member.get("owns", "-")))
            models = Counter(family(model_of(member)) for member in team.values())
            print("  %d members: %s" % (len(team), ", ".join("%d %s" % (count, model) for model, count in models.most_common())))
            if state.get("limits"):
                print("  limits: " + " ".join("%s=%s" % kv for kv in state["limits"].items()))
            for error in limit_errors(state):
                print("  over limit: " + error)

        elif cmd == "attention":
            if args and args != ["--json"]:
                sys.exit("attention accepts only --json")
            report = attention(state, posts)
            if "--json" in args:
                print(json.dumps(report))
            else:
                for item in report["items"]:
                    print("[%s] %s%s" % (item["kind"], "#%d " % item["seq"] if item["seq"] else "", item["text"]))
                print("%d item(s) need attention; `show` prints the posts" % len(report["items"]) if report["items"] else "nothing needs attention")

        elif cmd == "retry":
            for key in ("wake_claim", "told", "last_nudged_seq"):
                members[known(args[0])].pop(key, None)
            save(d, state)
            print("delivery to @%s will be tried again" % known(args[0]))

        elif cmd == "replace":
            old, new = known(args[0]), args[1].lstrip("@").lower()
            # A removed member can still be replaced: that is how the members waiting for it get a successor.
            if old == COORDINATOR or new in members or not NAME.fullmatch(new) or new == "all":
                sys.exit("replace needs an existing member and a new, unused name")
            before = set(limit_errors(state))
            entry = {key: value for key, value in members[old].items() if key in INHERITED}
            given = assignments(args[2:], MEMBER_FIELDS - {"killed", "backend"})
            entry.update(given)
            if (kind_of(entry) == "investigator" and family(model_of(entry)) == "fable"
                    and not (kind_of(members[old]) == "investigator" and family(model_of(members[old])) in {"opus", "fable"}
                             and effort_of(entry) == "medium")):
                sys.exit("Fable escalation requires replacing an Opus investigator with model=fable effort=medium")
            entry["last_read_seq"] = len(posts)
            members[old]["killed"] = "1"
            validate_member(new, entry, given, members)
            members[new] = entry
            for member in members.values():  # whoever waited for the old member now waits for the new one
                if member.get("depends"):
                    member["depends"] = ",".join(new if dep == old else dep for dep in dependencies(member))
            # Only what this command asks for: an inherited wait for a removed member is the blocked
            # state Attention already lists, and replacing the waiter must stay possible.
            if any(dep not in members or members[dep].get("role") != "worker" or members[dep].get("killed")
                   for dep in dependencies(given)):
                sys.exit("dependencies must be registered, active workers; nothing was changed")
            looped = cyclic(members)
            if looped:
                sys.exit("dependency cycle through @%s: a member that waited for @%s would wait for itself; nothing was changed"
                         % (looped, old))
            errors = [error for error in limit_errors(state) if error not in before]
            if errors:
                sys.exit("over the run's limits, nothing was changed: " + "; ".join(errors))
            is_brief = re.compile(r"@%s[ \t,]+BRIEF\b" % re.escape(old), re.IGNORECASE)
            briefs = [p for p in posts if p["agent"] == COORDINATOR and is_brief.match(p["text"])]
            body = "\n".join(briefs[-1]["text"].split("\n")[1:]) if briefs else "(@%s had no brief on the board)" % old
            history = " ".join("#%d" % p["seq"] for p in posts if p["agent"] == old) or "none"
            # what the old member was sent and never read would otherwise be lost with it
            owed = " ".join("#%d" % p["seq"] for p in posts if old in p["to"] and p["seq"] > members[old]["last_read_seq"])
            post_message(COORDINATOR, "@%s BRIEF (replaces %s)\n%s\nPredecessor: %s was removed. Its posts: %s. "
                         "Read them before you start, with the show command for %s, and do not redo what they report as done.%s"
                         % (new, old, body, old, history, old,
                            " It never read these posts addressed to it, which are now yours to answer: %s." % owed if owed else ""), [new], save_roster=True)
            print("spawn @%s as swarm:%s, then record its id" % (new, kind_of(entry)))

        elif cmd == "post":
            sender = known(args[0])
            if members[sender].get("killed"):
                sys.exit(f"@{sender} has been retired")
            text = (" ".join(args[1:]).strip() or sys.stdin.read()).strip()
            if not text:
                sys.exit("empty post")
            # A report typed as a post records no readiness: verification would wait for it forever.
            protocol = REPORT_WORD.match(text)
            word = protocol[1] if protocol else ""
            if sender != COORDINATOR and word in {"READY", "REVISE"}:
                sys.exit("this is a plain post, so it records no readiness. Use: board.py DIR %s %s (report on stdin)"
                         % (word.lower(), sender))
            # VERIFIED counts only as the line verify.py returns for a candidate it tested.
            first = text.split("\n")[0]
            if word == "VERIFIED" and members[sender].get("role") != "verifier":
                sys.exit("only a verifier can post VERIFIED")
            if word == "VERIFIED" and not verified_line(d, sender, first):
                sys.exit("VERIFIED must be the line the coordinator's verify command returns: VERIFIED <candidate> <digest>. "
                         "Wait for the candidate; report anything else as NOT VERIFIED or as a note.")
            post_message(sender, text, [name for name in targets(text, members) if name != sender])

        elif cmd in {"ready", "revise"}:
            sender = known(args[0])
            member = members[sender]
            if state.get("closed") or member.get("role") != "worker" or member.get("killed"):
                sys.exit("only an active worker of an open run can " + cmd)
            if cmd == "ready":
                through = readiness(members, posts)
                blocked = [name for name in dependencies(member) if name not in through]
                if blocked:
                    sys.exit("waiting for " + ", ".join(blocked))
                revision = args[1] if len(args) > 1 else None
                if revision is not None and not COMMIT.fullmatch(revision):
                    sys.exit("expected a full commit ID")
                if revision is not None and (member.get("writes") == "0" or kind_of(member) in READ_ONLY):
                    sys.exit("a read-only report cannot include a commit")
                report = sys.stdin.read().strip()
                if not report:
                    sys.exit("READY needs a report on stdin")
                if kind_of(member) == "investigator":
                    post_message(sender, "FINDING awaiting coordinator review\n" + report, [COORDINATOR], kind="finding")
                    return
                text = "READY" + (" " + revision if revision else "") + "\n" + report
            else:
                revision = None
                text = ("REVISE " + " ".join(args[1:])).strip()
            notify_dependents = kind_of(member) != "investigator" or sender in readiness(members, posts)
            recipients = [name for name, entry in members.items() if not entry.get("killed") and
                          name != sender and (name == COORDINATOR or entry.get("role") == "verifier"
                                              or (notify_dependents and sender in dependencies(entry)))]
            post_message(sender, text, recipients, kind=cmd, revision=revision)

        elif cmd == "confirm":
            if len(args) != 2:
                sys.exit("confirm requires an investigator name and finding post number")
            name = known(args[0])
            member = members[name]
            if state.get("closed") or member.get("role") != "worker" or member.get("killed") or kind_of(member) != "investigator":
                sys.exit("only findings from active investigators on an open run can be confirmed")
            latest = latest_reports(posts).get(name, {})
            if latest.get("kind") != "finding" or str(latest["seq"]) != args[1]:
                sys.exit("only the investigator's latest unconfirmed finding can be confirmed")
            through = readiness(members, posts)
            if any(dep not in through or through[dep]["seq"] > latest["seq"] for dep in dependencies(member)):
                sys.exit("the finding's prerequisites changed; ask for an updated finding")
            recipients = [dep for dep, entry in team_of(members).items() if name in dependencies(entry) or entry.get("role") == "verifier"]
            post_message(COORDINATOR, "READY %s\nConfirmed %s's finding #%d. Read it with BOARD show %s."
                         % (name, name, latest["seq"], name), recipients, kind="ready", subject=name, revision=None)

        elif cmd == "read":
            # A reader pays in full only for posts addressed to it; the rest of the board costs it a line each.
            headers, everything = "--headers" in args, "--all" in args
            readers = [a for a in args if not a.startswith("--")]
            limits = [a for a in args if a.startswith("--max-bytes=")]
            if len(readers) != 1 or len(limits) > 1 or len(set(args)) != len(args) or set(args) - {*readers, *limits, "--headers", "--all"}:
                sys.exit("read requires one member and accepts --all, --headers or --max-bytes=N")
            maximum = int(limits[0].partition("=")[2]) if limits else None
            if maximum is not None and not 256 <= maximum <= 1_000_000:
                sys.exit("--max-bytes must be between 256 and 1000000")
            me = known(readers[0])
            new = [p for p in posts if p["seq"] > members[me]["last_read_seq"]]
            emitted = size = 0
            for p in new:
                mine = me in p["to"]
                if headers or not (mine or everything):
                    lines = p["text"].split("\n")
                    p = dict(p, text=" | ".join(lines[:2 if p.get("kind") else 1]))
                output = ("* " if mine else "") + show(p)
                if maximum is not None:
                    size += len(output.encode("utf-8")) + 1
                    if size > maximum:
                        if not emitted:
                            sys.exit(f"post #{p['seq']} exceeds the read page. Ask the coordinator to review it with show --post={p['seq']} or raise --max-bytes.")
                        break
                print(output)
                emitted += 1
            layout = ("one line per post" if headers else "all posts are shown in full" if everything else
                      "posts marked * mention you and are shown in full")
            print(f"{emitted} new post(s); {layout}" if emitted else "no new posts")
            if emitted < len(new):
                print(f"{len(new) - emitted} more post(s) remain. Read again for the next page.")
            sys.stdout.flush()
            if emitted:
                members[me]["last_read_seq"] = new[emitted - 1]["seq"]
                save(d, state)

        elif cmd == "show":
            who = args[0].lstrip("@").lower() if args else None
            if who and not re.fullmatch(r"--post=[0-9]{1,9}", who) and who not in members:
                sys.exit("show takes a member name or --post=N; members: %s" % " ".join("@" + n for n in members))
            if who and who.startswith("--post="):
                seq = int(who.partition("=")[2])
                if not 1 <= seq <= len(posts):
                    sys.exit("no post with that sequence")
                print(show(posts[seq - 1]))
                return
            for p in posts:
                if who is None or who == p["agent"] or who in p["to"]:
                    print(show(p))

        elif cmd == "wake":
            for name, member in members.items():
                owed = unwoken(name)
                if name != COORDINATOR and waiting(member) and owed:
                    claim = member.get("wake_claim", {})
                    exhausted = claim.get("seq") == owed[-1] and claim.get("attempts", 0) >= WAKE_ATTEMPTS
                    suffix = " (attempts exhausted)" if exhausted else ""
                    print("@%s %s through #%d%s" % (name, member.get("id") or "NOT-SPAWNED", owed[-1], suffix))

        elif cmd == "claim":
            name = known(args[0])
            member = members[name]
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
            member = members[known(args[0])]
            seq = int(args[1])
            claim = member.get("wake_claim", {})
            if claim.get("token") != args[2] or claim.get("seq") != seq:
                sys.exit("wake claim no longer matches")
            member["last_nudged_seq"] = max(seq, member.get("last_nudged_seq", 0))
            member.pop("wake_claim")
            told = member.get("told", {})
            member["told"] = {"seq": seq, "at": time.time(),
                              "times": told.get("times", 0) + 1 if told.get("seq") == seq else 1}
            save(d, state)

        elif cmd == "rearm":  # an agent's turn ended: a wake it did not answer with a read is owed again
            duration = int(args[0])
            if duration < 0:
                sys.exit("turn duration cannot be negative")
            started = time.time() - duration / 1000
            changed = False
            for name, member in members.items():
                if (member.get("killed") or member.get("id") not in args[1:] or not unread(name) or unwoken(name)
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
            if state.get("closed") and state.get("binding") != args[0]:
                sys.exit("the run is closed")
            state["binding"] = args[0]
            save(d, state)
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            atomic_write(path, os.path.basename(os.path.abspath(d)) + "\n")
            if adopted:
                print(os.path.abspath(d))

        elif cmd in {"pause", "resume"}:
            if cmd == "pause":
                state["paused"] = " ".join(args) or "awaiting coordinator"
            else:
                if over_budget:
                    sys.exit(f"token budget spent ({total} of {budget}); raise it with limit before resuming")
                state.pop("paused", None)
            save(d, state)

        elif cmd == "close":
            owed = unread(COORDINATOR)
            if owed:
                sys.exit("@coordinator has not read %d post(s) addressed to it, from #%d on. Run: read coordinator, then close"
                         % (len(owed), owed[0]))
            state["closed"] = True
            state.pop("paused", None)
            save(d, state)

        elif cmd == "status":
            status = " (closed)" if state.get("closed") else " (paused)" if state.get("paused") else ""
            print("%s: %d posts%s" % (state["title"], len(posts), status))
            if total or budget:
                amount = f"{total} of {budget}" if budget else str(total)
                print(f"Usage: {amount} tokens")
            for name, m in members.items():
                mine = [p["seq"] for p in posts if p["agent"] == name]
                extra = " ".join("%s=%s" % kv for kv in m.items() if not kv[0].startswith("last_") and kv[0] not in {"wake_claim", "told"})
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

# swarm

A Claude Code plugin that runs a team of named agents on one task. The agents split the task, work on the pieces at the same time, and coordinate on one shared message board. A verifier reviews the diffs and runs the tests before you see the result. It is modelled on the `/swarm` command of Google Antigravity.

Use it when a task divides cleanly across separate files, packages, test suites or questions. Every worker is its own agent, so a swarm uses quota much faster than one conversation.

## Install

```
claude plugin marketplace add marspater/claude-swarm
claude plugin install swarm@swarm-local
```

## Use

```
/swarm:swarm Add unit tests for the date utilities in src/utils/date.ts and the currency formatter in src/utils/currency.ts, and run npm test to verify.
```

Say what you want and how to check it. The conversation you type this in becomes the coordinator. It:

1. gives the team a name (hive themed and not safe for work, on purpose) and splits the task into pieces that do not collide, one worker per piece (`@parser`, `@api-tests`, or a numbered pool `@fix-1` to `@fix-4`);
2. posts a public brief for each worker: what it owns, what it must not touch, what "done" means;
3. adds a verifier for the integrated result when the task changes code;
4. starts every member as a background agent, then waits.

The coordinator does no technical work itself, so you can keep talking to it: ask for status, change the scope, or tell it to add or remove a worker.

In Claude Desktop, click **Swarm Board** above the composer (the first item on crab-buddy's row when that plugin is installed) or **Open Swarm Board** on the coordinator's **Swarm deployed.** reply. Both buttons open the pane directly during a coordinator turn without sending a message or interrupting it. **Swarm Board** is shown only in a project that has had a Swarm run; elsewhere nothing of the plugin appears until you start one. In the terminal, `/swarm-board` opens the pane immediately. The Desktop composer can queue a typed slash command while a turn is running. The live pane shows the board feed, items needing attention, member status, and an @mention graph with replay.

In the pane:

- **Filter the board.** Type in the filter box and press Enter. Words match the post text, `@name` matches sender or recipient, `from:name` and `to:name` match one side (`@all` and a group's name match the posts that mention them), and a kind such as `brief` or `verified` matches the post's label. All words must match.
- **Open an agent.** A sender's name on a post, or **Open conversation** on the Members tab, shows that agent's own conversation: in the main view in the terminal, and inside the pane in Desktop, which has no main view to switch. The coordinator's conversation is offered only for a run this conversation drives or drove; for another run its Members card offers **Posts** alone. **Posts** on a member, or a name under the graph, shows that member's feed.
- **Collapse history** follows only the latest post; **Show history** restores earlier posts.
- **Read the graph.** A solid arrow is a mention by name, and its width grows with the count. A post to `@all` is counted in a chip on its sender; **Expand @all** draws it as a dashed arrow to each member it reached. A dashed outline marks a member that posted with no mention. The key under the diagram repeats this. A dense graph leaves out its quietest routes, saying how many, and always draws the routes of the post shown; a graph too dense to draw, or a pane too narrow for its names to be read, lists the routes instead. The drawing's description names the post shown and how many members it draws, and **List the routes** under it gives every route in words, for the keyboard and a screen reader; a long list shows a short page first and **Show more routes** adds the next. **Run** and **Replay** label the two rows of steps, and a step that leads nowhere is plain text. A closed, paused or browsed run's graph moves only while it is replayed, and a closed run's graph shows no live status. A pass of a partial candidate reads **Partial pass** with the workers it covered, never `VERIFIED`, and `+N more` on a post lists all its recipients.
- **Steer the run.** **Pause run** and **Resume run** in the header, and **+500k & resume**, **+250k & resume** and **Retry** on Attention items, run the board command themselves, so they cost no coordinator turn. The other Attention buttons (**Ask coordinator to …**, **Tell coordinator**) send the coordinator a request, which starts a turn of its own. All of them appear only for the open run this conversation drives. A pause from the pane is not announced to the coordinator: it finds the run paused in `attention` or `status`. Resuming, from the pane or the coordinator, posts to the workers, consultants, and verifiers the pause stopped mid-work, so they are woken at once.
- **Look at another run.** **‹ Prev run** and **Next run ›** step through the project's other runs, read-only, and show as plain text at either end of the history: the pane reads the run list as it opens; **Back to live run** returns. The live run keeps running behind it. A browsed run is read once: when its board or Attention report cannot be read the pane says so, and **Retry** reads it again in place.
- **Read a commit.** **View diff** on a `READY` that names a commit shows it under the post, cut at 12,000 characters, with a line saying what it covers; **Hide diff** closes it. A report that records a base (the project's `HEAD` when the `READY` was posted, or where the member's branch began when that lies above it, as for a branch from another ref) shows the first-parent commits since that base with merges omitted, less the commits its `except` list holds (its dependencies' `READY` commits, so one fast-forwarded into the branch or merged by hand is left out too): a synced dependency's merge is left out, and a conflict resolution recorded in a merge would not show. One without a base shows what it adds to the project's `HEAD` (`git diff HEAD...<commit>`), and once it adds nothing, its last commit only.
- **Export.** **Export MD** in the header runs the board's `export`, which writes the shown run as Markdown (`<run>/summary.md`), and says where.
- **Post as the coordinator.** On the Board tab of the run this conversation drives, the box above the filter posts to the board in the coordinator's name, its first line `(from the user, in the pane)`. It costs no coordinator turn: the coordinator is told with its next tool call which post you made, and to read it.

More examples:

```
/swarm:swarm Add input validation to the three API handlers in src/routes/users.ts, orders.ts and products.ts. One worker per handler, tests next to each, and a verifier runs npm test.
/swarm:swarm Find out why our CLI takes four seconds to start. Three read-only workers investigate module imports, config loading and plugin discovery, then combine their findings into a ranked list of fixes.
/swarm:swarm Add retry with backoff to pkg/httpclient and pkg/webhooks. Run the verifier on opus and have it run go test -race ./...
```

Experimental: to use Claude's native shared task list, launch `/swarm:swarm --native-teams <task>` from a session where Agent Teams is already enabled. Native teams use the shared workspace. The default continues to use background subagents and supports isolated Git worktrees.

### Preview a team: `/swarm:plan`

`/swarm:plan <task>` shows the smallest team for a task before any run exists: who owns which paths, who waits for whom, each member's model and effort, the checks the verifier would run, and a rough token cost. For a small or tightly coupled task the answer can be that one agent is enough. It reads the code but starts no run and edits no project file: no run folder, no member, no edit. A long task is saved under `.swarm/tasks/` as for `/swarm:swarm`. It takes a model turn, because splitting work needs judgement, so it is a skill command (`/swarm:plan`), not the `/swarm-plan` form the instant commands use. Start the run with `/swarm:swarm` and the same task in the same conversation, and the coordinator starts from the accepted plan.

### Ending a run with `/swarm-kill`

`/swarm-kill [reason]` ends the run this conversation drives at once, with no model turn, even while the coordinator is working. When the kill lands mid-turn, the coordinator's tool calls in that turn are refused with an instruction to end it, and the compaction waits for the turn to finish. The board retires every member and closes the run. A member still working stops at its next tool call, and a retired member's hand-back is dropped so it does not wake the conversation. The answer names any member still running and any process a retired member left in its worktree, with the `kill` line to stop it. The files stay as the members left them. The conversation is then compacted without the Swarm rules and goes on as an ordinary assistant. If the compaction cannot run, Swarm tells you to run `/compact`. A new `/swarm:swarm` starts a run as usual.

## Seeing and limiting the cost

**The plan comes first.** Before any member starts, the coordinator shows the team as a table: each member's type, model, effort, what it owns and what it waits for. It sizes the team from what is known to be wrong, not from how much code there is, and says why. It starts straight away for a team of three or fewer on the default models and effort. It asks how many to deploy, with its recommendation and the next smaller team, when the plan has more than three members, when a member would run on a stronger model or a higher effort than its type's default, when a member would run on Fable that you did not ask for, or when you asked to approve the plan.

**Limits go in the task.** Write them in plain words; the coordinator records them and the board enforces them (passing an empty value like `budget=`, `max_workers=`, `max_members=`, or `fable=` clears a limit):

| You write | The run gets |
| --- | --- |
| "at most three workers" | `max_workers=3`: a fourth worker is refused. Workers are all members except verifiers |
| "use Fable only for architecture" | `fable=architect`: any other member on Fable is refused at registration and again at spawn |
| "no Opus" | `opus=none` |
| "stay under two million tokens" | `budget=2000000`: when it is spent the run pauses, so no member is woken again, and the coordinator asks you what to do. A member that is mid-turn is refused its next tool call and told to end its turn, as on any pause, and no new member can be started until you raise the budget |

**The budget is yours.** The coordinator may lower it, and may raise it only to a figure you wrote in the conversation. It is judged against the budget the run has saved, never the pane's last view of it, and a run whose roster cannot be read counts as having none. A `limit` command the hooks cannot read for sure is refused rather than guessed: one whose run folder or options a variable, a glob or a substitution hides, one inside `$(…)`, and one whose run folder climbs out of a folder with `..` (`run/link/../.swarm/…`, where a symlink leads the board elsewhere than the path reads). The board tool and a plain `board.py <run> limit budget=<tokens>` always work for a change that lowers the budget. A raise, or `budget=` that lifts the budget, takes `--raise` (`board.py <run> limit --raise budget=<tokens>`), even for a figure you approved: the hooks pass it only with your figure, and the board, which writes under its lock, refuses a raise without it, so a cut approved against one budget cannot land as a raise after you lowered it.

**Every run has a budget.** A run's budget is allocated from its planned team: each member's type, effort and the size of its piece, plus a share for the coordinator and a reserve. It is shown with the plan, fixed when the first member starts, and the run pauses there for your decision. Name your own figure and the board uses that instead. A budget at or below what the run has already used is refused, since it could only stop the members mid-work.

**Tokens are counted.** The pane shows tokens per member and for the run, against the budget when there is one. The count is input, cache writes and output, plus cache reads at a tenth, and it is taken at every model step, so a budget is noticed mid-turn. The count is saved with the run, so resuming the coordinator keeps the total and enforces the same budget. Usage from before this change cannot be recovered. A task of 16,000 characters or more, such as a pasted log, given to `/swarm:swarm` or `/swarm:plan`, is saved to `.swarm/tasks/<time>.md`, a folder that keeps itself out of git: the coordinator gets its first 4,000 characters, its last 2,000 and the path, and reads what it needs from the file, because text held in the conversation is re-read at every step of the run. A task over 2,000 characters is also held once, not twice: the skill's copy of it points at the command's own message.

**Members read only what is theirs.** A member sees in full only the posts that mention it; the rest of the board costs it one line per post. Each member type also carries a role skill that tells it to search before it reads and to stay inside its piece.

## Needs attention

The pane's **Attention** tab, and `board.py attention` for the coordinator, list what is stuck. Each item names the board post that shows it, and the tab opens that post.

| Item | Means |
| --- | --- |
| Question | A member was asked something and has not answered the asker |
| Blocked | A member waits for one that is missing from the roster, was removed, is unreachable, is ignoring its mentions, is paused on its own budget, or was never started |
| Unstarted | A member has a brief and no agent: its spawn never happened or was cut off |
| Review | The coordinator must review an investigator's exact finding before confirming it and releasing dependents. The tab offers "Ask coordinator to review" |
| Unread | Posts addressed to the coordinator that it has not read. It is also told in its next tool result, and by a prompt when idle; `close` refuses until it reads them |
| Ignored | A member was woken three times in a row and still has not read its mentions. The tab offers "Retry" |
| Unreachable | Three wakes failed. The tab offers "Ask coordinator to recover" |
| Retired running | (Swarm pane only) A retired member's agent is still alive (`running`, `pending`, or `waiting`); stop it before spawning or replacing |
| Silent | (Swarm pane only) A worker's agent ended after it read its mentions, and it has posted nothing since: no report, no question, nothing it waits for. The coordinator is told once, with its next tool call |
| Stale | A worker or designer reported a change after the verifier's `VERIFIED` |
| Rework | A worker failed verification twice in a row. A third failure pauses the run. The tab offers "Ask coordinator to intervene" |
| Dispute | A worker disputes a finding and the verifier keeps it open. The run pauses for the coordinator to resolve it |
| Heavy | A read-only member reached the context ceiling and already filed its report. Use its report or replace the member to continue the assignment |
| Spend | One member has used more than half of the run's tokens, once the run has used at least 200,000 tokens and three or more non-coordinator members have recorded usage. With exactly two, one that has used more than three quarters of the pair's tokens, once the pair has used at least 200,000 tokens |
| Paused | The run is paused, with the reason. On a spent budget the tab offers "+500k & resume" |
| Member paused | A member spent its own token budget (`member_budget`, or `budget=` on the member). Its tool calls are refused at once, the coordinator is told once, and the tab offers **+250k & resume**, which raises its budget and runs the board's `resume <name>` |
| Loop | A worker or verifier reached 150 model steps or 750,000 tokens since it last posted or read the board |
| Conflict | Two current `READY` commits change the same files, so merging them will conflict |
| Dispatch | The planned candidate's dispatch is owed and nobody serves it: its waiter ended, could not start, gave up after two hours, or the prepare failed (the item says which). Run `dispatch`; once it posts the test command the item goes |

Every other item offers "Ask coordinator to handle" ("Tell coordinator" for one about the coordinator itself). A closed run lists nothing.

Every post command also prints `UNREAD: …` to a sender that owes a read, which works even where the hooks are not loaded. The Board tab labels its recent window and can page backward through older posts. The graph uses the recent window. The pane shortens long posts for display only: `board.jsonl` holds the full text and `show --post=N` prints it. `read --max-bytes=N` pages its output and cuts a post longer than a page, naming that command. The board tool reads in pages of 48,000 bytes and cuts a longer `show` to one page.

**The board tool** (`mcp__swarm__board`) runs board commands under the caller's own name, so nobody can post or report as another through it. A member's board and verify commands typed in Bash are checked too, as far as their words show: a member may read, show, see `status`, and post, report ready, withdraw and sync under its own name only, and only a verifier runs `verify.py test`, under its own name. They are read through `cd … &&`, env prefixes, python's flags (with their values: `-Wonce` holds no `-c`), quoting, `sh -c`, `eval`, `env -S` and `$(…)`; one whose subcommand or name a variable, a substitution or a wrapper hides is refused, and so is a program that names the board given inline (`python3 -c`, a module such as `runpy`, `perl -e`, `node -e`) or fed to a shell or interpreter from a pipe or a heredoc. The hook rejects a board or verify script name passed to an unrecognized launcher (`uv run board.py …` included); file commands that only copy, move or describe it (`cp`, `mv`, `rm`, `ls`, `cat` and the like) do not run it. A member's own script can contain commands the hook cannot inspect. For foreground Bash calls the shared-checkout guard reports a change to HEAD between the start and end of the call. A background Bash call returns at launch, before there is a final HEAD to compare. A specialist reads, shows, posts, sees `status`, and reports ready or withdraws it. A worker or designer does the same, and a `ready` for a commit takes its full id (`HEAD` is resolved only by the board command run from the member's own checkout). A verifier reads, shows, posts and sees `status`: its verdict is a post. The coordinator drives the run its conversation owns: `init` (a run folder `name` and a `title`), `member`, `limit` and `replace` (with `options` as `key=value` strings), `plan`, `attention`, `post`, `read`, `show`, `confirm`, `retry`, `pause`, `resume` (the run, or one `name`), `status`, `close` and `export`. A call through the tool sets off what the same command typed in Bash does: binding the run, clearing what the coordinator owes, syncing retirements and pauses. The command in Bash keeps working, and workers, designers and the verifier fall back to it when the tool goes unanswered (see Limits).

The **Members** tab says what each member is doing: coordinating, working, waiting for a named member, waiting for an answer to a named post, reported ready, run paused, its token budget is spent (a member paused on its own budget), unreachable, failed, stopped (its agent was stopped while it is still on the roster), killed (Retired), or not started. A closed run lists its members under **At close** with the last report each made (`READY`, a verdict, …) or "No outcome recorded", and its retired members under Retired. To recover an unreachable member the coordinator runs `retry` once, then `replace <old> <new>`, which registers a successor with the old member's brief, dependencies and the numbers of its posts (`replace` refuses an already-replaced member, and the spawn hook refuses spawning the replacement while any predecessor or killed member with overlapping `paths=` is still active).

## Specialist and designer profiles

- **`swarm:explorer`** uses Haiku at medium effort to locate code, call sites, and tests.
- **`swarm:investigator`** uses Opus at medium effort to investigate ambiguous bugs and design flaws. Fable is an escalation only: when the Opus investigator cannot settle the question, the coordinator replaces it with one on Fable at medium effort that starts from its posts. The board refuses an investigator registered on Fable any other way.
- **`swarm:architect`** uses Fable at high effort to design new software from small tools to complex systems, review existing architecture, and plan optimization and migrations. It is also the coordinator's consultant: during a run the coordinator can ask it one question about a complex decision, such as a disputed contract or a doubtful split, and get a recommendation on the board. A consultation runs at medium effort.
- **`swarm:designer`** uses Opus at high effort for UI/UX and visual design: screens and component specs, design tokens, icons and vector assets, and app-icon artwork. Unlike the three specialists it writes files and, like a worker, uses the board command or the board tool. It hands workers a spec and assets and writes no production feature code. For a macOS, iOS or iPadOS target it reads its Apple platform rules; for anything else it works from the platform-neutral ones. The verifier renders and measures its deliverables, and the UI workers build from them.

The `swarm:` agents and the board tool work only inside a Swarm run you started with `/swarm:swarm`: with the hooks module active, a `swarm:` agent starts or resumes only as a member its coordinator registered in an open run, and in a conversation that drives no run the board tool refuses and the hooks add nothing to its tool calls or turns.

Every member type, the worker and verifier included, is pinned to the newest model of its family, and a family name passed for a member starts that model. The versions are in one table, `hooks/models.ts`, and in each agent file's `model:` line.

The coordinator can select these profiles when splitting a task. You can also ask for one explicitly, for example `/swarm:swarm Have an investigator trace duplicate refreshes and an architect review the proposed fix`. The three specialists have read tools and a scoped board tool for findings and readiness. They require the hooks module. In native Agent Teams, use in-process display for specialists.

## Skills

| Skill or reference | For | What it holds |
| --- | --- | --- |
| `swarm` | You, to start a swarm (`/swarm:swarm`) | The coordinator's procedure: board commands, start-up, the loop, verification, finishing |
| `plan` | You, to preview a split (`/swarm:plan`) | Dry-run split: file ownership, dependencies, models, checks, and rough cost estimate without starting a run |
| `swarm/references/orchestrating.md` | Coordinator, read when needed | When a swarm fits, how to split work, and the team shapes: parallel pieces, pool, pipeline, design then build, investigate then fix, competing explanations, review fan-out |
| `swarm/references/agent-types.md` | Coordinator, read when needed | Which agent for which piece: the swarm's six member types, the built-in agents, and other plugins' agents |
| `swarm/references/team-management.md` | Coordinator, read when needed | The roster, workspaces, permissions, adding, replacing and removing members, shutdown, recovery, closing a run |
| `swarm/references/messaging.md` | Coordinator, read when needed | The board protocol: mentions, kinds of post, delivery, troubleshooting |
| `swarm/references/native-teams.md` | Coordinator, read only for a `--native-teams` run | What experimental native Agent Teams mode changes in each step: Agent Teams check, named teammates, native tasks, in-process display, shutdown |
| `swarm/references/rlm.md` | Coordinator, read only for content over about 5,000 lines or 50K tokens | The RLM pattern for content too large for one context: partition the data, one Haiku analyst at low effort per slice, one synthesizer |
| `implementing` | `swarm:worker`, preloaded | Smallest change that meets the brief, building from a designer's spec, narrow tests first, a short `READY` |
| `verifying` | `swarm:verifier`, preloaded | Diffs against briefs, the full checks once on the integrated candidate |
| `verifying/references/design-verification.md` | `swarm:verifier`, read by it only when the run has design work | Rendering and measuring design work, the redline, and how to report it |
| `design-craft` | `swarm:designer`, preloaded | Platform-neutral rules for vector geometry, layout, type, color and tokens, component states, and the render-and-report step |
| `design-craft/references/apple-design.md` | `swarm:designer`, read by it only for a macOS, iOS or iPadOS target | Native rules that complement `design-craft`: HIG idiom, Liquid Glass, SF Symbols, Dynamic Type, app icons, SwiftUI-ready specs. It points to `liquid-glass.md` beside it for release changes and API patterns |
| `exploring` | `swarm:explorer`, preloaded | Search instead of reading; a short map of exact references |
| `investigating` | `swarm:investigator`, preloaded | Trace the real path, test competing explanations, hand over a regression check |
| `architecting` | `swarm:architect`, preloaded | Turn requirements into architecture, justify its complexity, and plan implementation and verification in stages |

The six role skills (`implementing`, `verifying`, `design-craft`, `exploring`, `investigating`, `architecting`) are hidden from the `/` menu. The menu lists `/swarm:plan` and `/swarm:swarm` alongside `/swarm-board` and `/swarm-kill`. The coordinator reads its six references as it needs them. Each member type gets exactly one role skill, injected when it starts, and can load no other: the worker, designer and verifier deny the Skill tool, and the three specialists have a fixed tool list without it. The designer reads its Apple rules as a file, and the verifier its design method.

The plugin and its guidance were written for this project. The RLM pattern follows the Recursive Language Models paper (arXiv:2512.24601).
The MIT terms for adapted code are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## How it works

| Antigravity swarm | This plugin |
| --- | --- |
| Coordinator | The conversation that ran `/swarm:swarm` |
| Named workers and verifier | Background subagents `swarm:worker`, `swarm:verifier`, an optional `swarm:designer`, and optional read-only specialists |
| Shared board | `.swarm/<name>-<date>-<time>/board.jsonl` in the project, one folder per run, written only through `skills/swarm/scripts/board.py` |
| `@name`, `@group`, `@all` mentions | Resolved by `board.py` when the post is written and stored with it; each member has a read cursor in `members.json` |
| A waiting member uses no tokens | A subagent whose turn ended is idle |
| A mention wakes a waiting member | The hooks reconcile every two seconds. An accepted send records delivery through a sequence. The member advances its read cursor when it reads the board |
| `@monitor` | The hooks notify the coordinator once after 30 seconds without progress on an open, unpaused run |
| Per-worker working copy | `isolation: "worktree"`; `verify.py` builds the candidate from exact worker commits, runs the requested checks there, and fast-forwards a clean checkout to the verified commit |
| Models | Defaults: coordinator Opus at medium effort, workers and verifier Sonnet at medium. The coordinator raises the verifier to Opus at medium when the change crosses several components, touches security, or includes design work. Name another model or effort in the prompt for any worker, all workers, or the verifier |
| Swarm pane | **Swarm Board** in Desktop, or `/swarm-board` in the terminal |

The `.swarm` folder ignores itself in git, unless it already holds a `.gitignore` of the project's own, which is left as it is. Verification leaves the project's own `.swarm` folder out of the source fingerprint either way. A folder named `.swarm` anywhere else in the repository is source like any other.

When `prepare` replaces a comparable candidate, it reports the number of changed source paths and lists up to 20. A planned run includes that summary in the verifier's board post. The verifier still runs every check on the new candidate. The per-file fingerprints the comparison reads are kept in `<run>/candidate-sources.json`, apart from `verification.json`, which every verifier attempt rewrites.

A planned candidate (`prepare … --when-ready`) is prepared by the step that completes the team. When another verification action holds the checkout's lock at that moment (a verifier's test, a `prune`, a prepare for another project in the same Git checkout), the board records the dispatch as owed in the run's own state and starts one background waiter. The waiter prepares the candidate and posts its test command as soon as the lock is free, and gives up after two hours with a post to the coordinator. A waiter that ended early, could not start or gave up, and a prepare that failed, leave the dispatch owed with the reason, shown as a **Dispatch** item in Attention until `dispatch` serves it. A waiter is told apart by the lock it holds, not by its process id. Each verifier is asked once per candidate, however many dispatches reach it: the board marks its own test requests (`requests` on the post), so a note that names a candidate is no request. A verifier's new agent (a replacement address) is shown the request for the candidate on the table once, on its first read, as it is shown the `READY` reports it works from. Each refusal gets a token of its own, and a dispatch clears only the entry it served. Nothing is posted to a run that closed while its candidate was prepared. If a waiter prepared the candidate but ended before posting, `dispatch` posts the request once and clears the entry.

## Limits

- Waking members and the stall call need the hooks module, and only the conversation that started a run drives it. A conversation becomes a run's owner when it starts a registered member of it, so the form of the coordinator's board commands does not matter. When two unowned runs in one project both have a member of that name, the board does not guess: the run folder named in the member's prompt decides, and with none named the start is refused until the coordinator claims its run with `read coordinator`. Without the module the coordinator wakes members itself, each time a member ends a turn.
- Explorers, investigators, and architects resume through the coordinator's `SendMessage` tool so Claude Code keeps their read-only board tool available. While the coordinator works, the hook lists pending relays in a tool result. When it is idle, Swarm can start a coordinator turn. Automatic transcript notices carry the **Swarm** label. Workers, designers and the verifier receive wakes directly; in a turn such a wake starts, Claude Code may leave the plugin's tool hooks out, so the board tool can go unanswered there, and they use the board command, which the wake names.
- Resuming the bound conversation restores its run while that run is open; a closed run is only shown. Other conversations may view the project's newest run without driving it. Such a run is read only while that conversation's pane is up: a session that never used Swarm reads no run.
- Failed wake attempts retry after a short lease, up to three attempts per member: a newer mention does not start the count again, and a delivered wake, a read by the member or `retry` does. A process crash after Claude queues a message and before the board records the acknowledgement can repeat the nudge. Workers use their board read cursor to avoid rereading delivered posts.
- Claude may leave native teammates stopped after resuming a conversation. The coordinator uses board history to replace unreachable members.
- Verification hashes tracked and non-ignored untracked source files before and after checks, and checks the same snapshot at acceptance. Direct generated files to `$SWARM_VERIFY_OUTPUT_DIR`, which is shared by the checks in one attempt, or use targeted ignore rules. A check that adds untracked files to the candidate names them in its refusal. Use a clean checkout and provision dependencies from lockfiles for release checks. Ignored files, external services and other inputs outside the fingerprint can still affect a check. Checks run without Git's repository environment variables. Registered linked worktrees inside the project are outside the source fingerprint, and `accept` refuses to fast-forward over an ignored or untracked file in the candidate's way, a parent folder's name included.
- Each check has a 15-minute default timeout and a 16 MiB log limit. Set `--timeout <seconds>` or `SWARM_VERIFY_TIMEOUT` for a different check limit. The checks and any baseline replay have a one-hour budget by default, extended to at least the per-check limit. Set `SWARM_VERIFY_ATTEMPT_TIMEOUT` to give them a different total budget. A timed-out check is reported alongside other failures and the next check runs if time remains. Each check ends its process group, so start and use a background server in the same check. Cleanup also looks for descendant process groups. Detached processes that already reparented can outlive it. Set `SWARM_VERIFY_TIMINGS=1` to see setup, execution, and final source-validation times.
- Swarm coordinates cooperative agents. Its `paths=`, `writes=0`, worktree and board-directory rules guard the editor tools. The board tool derives its actor from the caller. Bash hooks recognize common forms of board and Git commands, and the foreground shared-writer check reports a moved HEAD after the call. Shell programs have the host's filesystem permissions. Use host-level filesystem isolation for workloads that require a security boundary, including protection against direct changes to board files. Use the board tool or `board.py` for board writes so they go through the locking protocol.
- With `core.filemode=false`, Git keeps the mode its index has whatever the file on disk says. `init` records the tracked files whose executable bit already differs then, with the mode Git had for each. A shared commit refuses an executable bit the checks ran with that the commit would not hold, on a file the commit changes or on one whose difference is not the one recorded at `init`, and prints the `git add --chmod` that stages it.
- A shared Git run lands with the `verify.py … commit <candidate> -m <message>` command printed by `VERIFY accept`. It stages the verified files in a private index, runs the repository's commit hooks there, and publishes the exact resulting verified tree against the expected parent. Hooks that change the tree and concurrent staging changes cause a refusal. The commit will still run after a normal close if the acceptance remains current. The command excludes the run data and registered linked worktrees, and refuses while those paths have staged changes. The hooks also refuse common shared-writer commit commands and active-run waits based on a loose process match.
- If a shared commit lands but Git's index cannot be updated, the command prints the landed commit and the `verify.py … recover-index <candidate>` command. Recovery runs only while the expected commit and branch are still checked out and the index contains its original contents. If staging has changed, inspect it before making any adjustments.
- `prepare` refuses a candidate with a file rewritten whole, a lost trailing newline, formatting mixed with real changes, or a removed symbol that is still imported, unless the worker's `READY` declares it (`REWRITE:`, `REFORMAT:`, `NEWLINE:`, `REMOVED:`) or the coordinator allows it with `--allow <kind>:<target>`, which the candidate records. `prepare isolated --baseline-diff` waives a check that fails on the candidate's base with the same output. It compares what the checks print and how they end, never the files they leave: a setup that silently writes other data on each side is not seen.
- Each defect in a `NOT PASSED` gets an id (`F1`, `F2`). The worker's next `READY` answers each, only the verifier closes one, and a dispute the verifier keeps open pauses the run.
- `after=a,b` on a member is a wait that ends when each named member reports or is retired.
- An isolated candidate is built on the checkout's HEAD unless `prepare` is given `--base <ref>`. A candidate built on another ref is verified but not accepted into the checkout: its commits go out from the members' branches, as pull requests for instance. `prepare` names a member that did not branch from the base.
- In a shared candidate a checked-out submodule counts as its files, which staging its pointer does not change, so deinitialising it after a pass voids the pass. In an isolated candidate a clean one counts as the commit it sits on, as one that is not checked out does: checks there run without submodule contents, and a candidate that moves a submodule pointer cannot be accepted: land that change by hand. A shared `accept` refuses while a submodule holds uncommitted or untracked files of its own, which the printed `verify.py … commit` cannot stage: commit them inside the submodule, then verify again. That commit action is what stages a clean submodule's new pointer. It also refuses a Git repository of its own inside the project that is no submodule, which the commit would record as a bare pointer: add it as a submodule, ignore it or move it out. A submodule that is clean on a new commit is accepted, and the printed command stages its pointer, save one whose `.gitmodules` entry says `ignore = all`: `git add -A`, which the commit action stages with, skips it, so `accept` refuses and names the `git add -f` that stages it by hand. Files put in the folder of a submodule that is not checked out are refused as well, since no commit can hold them.
- A verifier is woken for piece reviews once every remaining worker is ready, including when the last outstanding worker is retired. A `READY` that arrives while others still work is held for the coordinator for up to ten minutes, or until the last member stops; questions, findings and verdicts are never held.
- Integration checkouts and old runs pile up under `.swarm`. Clean up with `prune` only; a run folder deleted by hand loses the run's history, and `prune` removes the pointer it leaves behind. `python3 <plugin>/skills/swarm/scripts/board.py <project>/.swarm prune [--days=N] [--dry-run]` removes the integration checkouts no candidate needs and moves closed runs idle for N days (14 by default) to `.swarm/archive`. It never touches an open run, a member's own checkout or a branch.
- A member's model cannot be changed while it lives. The coordinator replaces the member instead.
- The Attention tab's "Question" items are a heuristic: a post with a question mark that its recipient has not answered. A reply that cites a question's number (`re #12`) answers that question only. A report such as READY or VERIFIED can also answer an explicitly cited question. An unquoted question mark (such as a ternary outside backticks) can show up there.
- Limits are enforced on `swarm:` members. One-shot helpers and a `general-purpose` stand-in are kept inside them by the coordinator's instructions only.
- The six role skills are hidden from the `/` menu, but their descriptions, one short line each, are listed to the model in every session where the plugin is enabled. A role skill cannot be hidden from that list: Claude Code only preloads into an agent a skill the model may invoke. The coordinator's guides, the designer's Apple rules and the verifier's design method are plain reference files for that reason, and cost nothing until read.
- In native Agent Teams mode Claude skips role-skill preload and applies the agent definition's instructions. A native designer reads its role skill as a file. In-process tests on Claude Code 2.1.325 covered registration, reading briefs, and waking an investigator, worker, and verifier. Split-pane mode and native teammate recovery after restart still need acceptance tests.
- Token counts and budget enforcement need the hooks module. The board saves usage reported by turns in the conversation that drives the run. Only the coordinator and the run's members are counted: another agent started in the same conversation spends none of the run's budget.
- The pane keeps the newest 300 posts for browsing, filtering, and graph replay. Attention can open posts outside that window. Edge counts and headings include every post. Desktop shows the animated diagram, and the terminal lists its edges.
- The project is the session's working directory, with the run stored in `<project>/.swarm/<run>`. Isolated verification requires Git. Shared verification can fingerprint a project without Git.
- `board.py` and `verify.py` need Python 3.8 or later and a POSIX system (they lock with `fcntl`), and use the standard library only. `verify.py` needs Git for isolated runs.
- Past 4 MB of posts the pane reads only the newest 3 MB of the board (`board.py tail`); `board.py` itself always has all of it. Each member's last report and the graph's earlier routes then come from the board's own count over the whole journal (`attention --json`), joined only to a tail that ends at the same post.
- Background workers run under this session's permission settings. If a worker stops on a permission prompt for the board command, allow `Bash(python3 */skills/swarm/scripts/board.py *)` in your settings, and `Bash(python3 */skills/swarm/scripts/verify.py *)` for the verifier. A designer also reads files in `skills/design-craft/` from the plugin folder, which is outside the project: its Apple rules for an Apple target, and its role skill in native mode. A verifier of design work reads `skills/verifying/references/` and `skills/design-craft/references/` there.
- The pane is a hooks module, an early-access Claude Code API. The skill, the agents and the board script work without it.

## Develop

```
python3 -B tests/check.py          # the checks the uncommitted changes need
python3 -B tests/check.py --all    # everything, as CI runs it
```

`check.py` finds the `claude` binary on `PATH` or inside the desktop app. The checks it runs, one by one:

```
python3 tests/test_board.py
python3 tests/test_verify.py
claude plugin validate .
claude plugin test .
bunx tsc --noEmit
bun test hooks/units.test.ts hooks/graph.test.tsx
```

The hook tests (`hooks/*.test.ts*`) import `claude-code/testing`, which `claude plugin test` provides. The pure ones also run without the claude CLI:

```
bun test hooks/units.test.ts hooks/graph.test.tsx
```

`bunfig.toml` preloads `hooks/testing-shim.ts`, which serves `claude-code/testing` from `bun:test` under bun and stands aside under the claude binary. `register.test.tsx` needs the engine the kit gives each test, so only `claude plugin test` runs it. The parity test in `units.test.ts` compares the hooks' reading of mentions (`@verifiers` and `@dependents` included), code and URLs, questions, post kinds and the graph's route counts with the cases the Python side keeps in `tests/parity.json`. The claude kit reads no files, so only `bun test` checks them; it passes with nothing checked while the file is absent.

The type-check needs `.claude-plugin/types/`, which Claude Code generates when it loads the plugin from this folder and which is not committed or shipped. On a fresh checkout, load the plugin once (`claude --plugin-dir .`) before running `tsc`. Those declarations include every MCP tool connected on your machine (`claude-code-mcp`). `tsconfig.json` leaves that set out of the check: the plugin calls no outside MCP server, its own board tool is declared in `types/index.d.ts`, and with the machine's tools included one `tool.call` hook alone costs millions of type instantiations.

`claude plugin validate` does not use that setting: it reads `.claude-plugin/types/` as it is, so with many MCP servers connected it can report `register.tsx` as "not type-checked" after running out of memory. To validate cleanly, regenerate the folder from a session with no outside MCP servers, then validate:

```
claude --plugin-dir . --strict-mcp-config --mcp-config '{"mcpServers":{}}'
claude plugin validate .
```

Loading the plugin from your usual session writes the full set again. The folder is local only: it is not committed or shipped, so none of this reaches a user of the plugin. They are written by the Claude Code build that last loaded the plugin, so after an update `claude plugin validate` may check against newer types than `tsc` does until the plugin is loaded again.

`hooks/register.tsx` holds the session hooks and the pane; `hooks/guard.ts` holds the shared-checkout commit guard and the member board-command check, which `register.test.tsx` exercises through the hooks. What needs no engine lives beside it and is tested directly in `hooks/units.test.ts`: `roster.ts` (reading the roster and the board), `text.ts` (cleaning and cutting post text), `models.ts` (agent types and their models), `command.ts` (reading shell commands and recognising board commands), `graph.ts`, `hive.ts` and `palette.ts`.

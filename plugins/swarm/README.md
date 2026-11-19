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

In Claude Desktop, click **Swarm: The Board** above the composer (the first item on crab-buddy's row when that plugin is installed) or **Open Swarm board** on the coordinator's **Swarm deployed.** reply. Both buttons open the pane directly during a coordinator turn without sending a message or interrupting it. In the terminal, `/swarm-board` opens the pane immediately. The Desktop composer can queue a typed slash command while a turn is running. The live pane shows the board feed, items needing attention, member status, and an @mention graph with replay.

In the pane:

- **Filter the board.** Type in the filter box and press Enter. Words match the post text, `@name` matches sender or recipient, `from:name` and `to:name` match one side, and a kind such as `brief` or `verified` matches the post's label. All words must match.
- **Open an agent.** A sender's name on a post, or **Open conversation** on the Members tab, shows that agent's own conversation: in the main view in the terminal, and inside the pane in Desktop, which has no main view to switch. **Posts** on a member, or a name under the graph, shows that member's feed.
- **Collapse history** follows only the latest post; **Show history** restores earlier posts.
- **Read the graph.** A solid arrow is a mention by name, and its width grows with the count. A post to `@all` is counted in a chip on its sender; **Expand @all** draws it as a dashed arrow to each member it reached. A dashed outline marks a member that posted with no mention. The key under the diagram repeats this.
- **Steer the run.** **Pause run** and **Resume run** in the header, and the buttons on Attention items, run the board command themselves, so they cost no coordinator turn. They appear only for the open run this conversation drives. A pause from the pane reaches the coordinator at its next board command. Resuming, from the pane or the coordinator, posts to the workers, consultants, and verifiers the pause stopped mid-work, so they are woken at once.
- **Look at another run.** **‹ Prev run** and **Next run ›** step through the project's other runs, read-only; **Back to live run** returns. The live run keeps running behind it.

More examples:

```
/swarm:swarm Add input validation to the three API handlers in src/routes/users.ts, orders.ts and products.ts. One worker per handler, tests next to each, and a verifier runs npm test.
/swarm:swarm Find out why our CLI takes four seconds to start. Three read-only workers investigate module imports, config loading and plugin discovery, then combine their findings into a ranked list of fixes.
/swarm:swarm Add retry with backoff to pkg/httpclient and pkg/webhooks. Run the verifier on opus and have it run go test -race ./...
```

Experimental: to use Claude's native shared task list, launch `/swarm:swarm --native-teams <task>` from a session where Agent Teams is already enabled. Native teams use the shared workspace. The default continues to use background subagents and supports isolated Git worktrees.

## Seeing and limiting the cost

**The plan comes first.** Before any member starts, the coordinator shows the team as a table: each member's type, model, effort, what it owns and what it waits for. It starts straight away for a small team on the default models, and asks first when the plan has more than five members, when a member would run on a stronger model than its type's default, when a member would run on Fable that you did not ask for, or when you asked to approve the plan.

**Limits go in the task.** Write them in plain words; the coordinator records them and the board enforces them (passing an empty value like `budget=`, `max_workers=`, `max_members=`, or `fable=` clears a limit):

| You write | The run gets |
| --- | --- |
| "at most three workers" | `max_workers=3`: a fourth worker is refused. Workers are all members except verifiers |
| "use Fable only for architecture" | `fable=architect`: any other member on Fable is refused at registration and again at spawn |
| "no Opus" | `opus=none` |
| "stay under two million tokens" | `budget=2000000`: when it is spent the run pauses, so no member is woken again, and the coordinator asks you what to do. A member that is mid-turn is refused its next tool call and told to end its turn, as on any pause, and no new member can be started until you raise the budget |

**Tokens are counted.** The pane shows tokens per member and for the run, against the budget when there is one. The count is input, cache writes and output, plus cache reads at a tenth, and it is taken at every model step, so a budget is noticed mid-turn. The count is saved with the run, so resuming the coordinator keeps the total and enforces the same budget. Usage from before this change cannot be recovered.

**Members read only what is theirs.** A member sees in full only the posts that mention it; the rest of the board costs it one line per post. Each member type also carries a role skill that tells it to search before it reads and to stay inside its piece.

## Needs attention

The pane's **Attention** tab, and `board.py attention` for the coordinator, list what is stuck. Each item names the board post that shows it, and the tab opens that post.

| Item | Means |
| --- | --- |
| Question | A member was asked something and has not answered the asker |
| Blocked | A member waits for one that was removed, is unreachable, or was never started |
| Unstarted | A member has a brief and no agent: its spawn never happened or was cut off |
| Review | The coordinator must review an investigator's exact finding before confirming it and releasing dependents. The tab offers "Ask coordinator to review" |
| Unread | Posts addressed to the coordinator that it has not read. It is also told in its next tool result, and by a prompt when idle; `close` refuses until it reads them |
| Ignored | A member was woken three times in a row and still has not read its mentions. The tab offers "Retry" |
| Unreachable | Three wakes failed. The tab offers "Ask coordinator to recover" |
| Retired running | (Swarm pane only) A retired member's agent is still alive (`running`, `pending`, or `waiting`); stop it before spawning or replacing |
| Stale | A worker or designer reported a change after the verifier's `VERIFIED` |
| Rework | A worker failed verification twice in a row. A third failure pauses the run. The tab offers "Ask coordinator" |
| Spend | One member has used more than half of the run's tokens, when three or more non-coordinator members have recorded usage, past 200,000 tokens |
| Paused | The run is paused, with the reason. On a spent budget the tab offers "+500k & resume" |

A closed run lists nothing.

Every post command also prints `UNREAD: …` to a sender that owes a read, which works even where the hooks are not loaded. The pane shortens long posts for display only: `board.jsonl`, `read` and `show` always carry the full text.

The **Members** tab says what each member is doing: coordinating, working, waiting for a named member, waiting for an answer to a named post, reported ready, run paused, unreachable, failed, killed (Retired), or not started. To recover an unreachable member the coordinator runs `retry` once, then `replace <old> <new>`, which registers a successor with the old member's brief, dependencies and the numbers of its posts (`replace` refuses an already-replaced member, and the spawn hook refuses spawning the replacement while any predecessor or killed member with overlapping `paths=` is still active).

## Specialist and designer profiles

- **`swarm:explorer`** uses Haiku at medium effort to locate code, call sites, and tests.
- **`swarm:investigator`** uses Opus at high effort to investigate ambiguous bugs and design flaws. Fable is an escalation only: when the Opus investigator cannot settle the question, the coordinator replaces it with one on Fable at medium effort that starts from its posts. The board refuses an investigator registered on Fable any other way.
- **`swarm:architect`** uses Fable at high effort to design new software from small tools to complex systems, review existing architecture, and plan optimization and migrations. It is also the coordinator's consultant: during a run the coordinator can ask it one question about a complex decision, such as a disputed contract or a doubtful split, and get a recommendation on the board. A consultation runs at medium effort.

- **`swarm:designer`** uses Opus at high effort for UI/UX and visual design: screens and component specs, design tokens, icons and vector assets, and app-icon artwork. Unlike the three specialists it writes files and works through the shell board like a worker. It hands workers a spec and assets and writes no production feature code. For a macOS, iOS or iPadOS target it reads its Apple platform rules; for anything else it works from the platform-neutral ones. The verifier renders and measures its deliverables, and the UI workers build from them.

Every member type, the worker and verifier included, is pinned to the newest model of its family, and a family name passed for a member starts that model. The versions are in one table, `hooks/models.ts`, and in each agent file's `model:` line.

The coordinator can select these profiles when splitting a task. You can also ask for one explicitly, for example `/swarm:swarm Have an investigator trace duplicate refreshes and an architect review the proposed fix`. The three specialists have read tools and a scoped board tool for findings and readiness. They require the hooks module. In native Agent Teams, use in-process display for specialists.

## Skills

| Skill or reference | For | What it holds |
| --- | --- | --- |
| `swarm` | You, to start a swarm (`/swarm:swarm`) | The coordinator's procedure: board commands, start-up, the loop, verification, finishing |
| `swarm/references/orchestrating.md` | Coordinator, read when needed | When a swarm fits, how to split work, and the team shapes: parallel pieces, pool, pipeline, design then build, investigate then fix, competing explanations, review fan-out |
| `swarm/references/agent-types.md` | Coordinator, read when needed | Which agent for which piece: the swarm's six member types, the built-in agents, and other plugins' agents |
| `swarm/references/team-management.md` | Coordinator, read when needed | The roster, workspaces, permissions, adding, replacing and removing members, shutdown, recovery, closing a run |
| `swarm/references/messaging.md` | Coordinator, read when needed | The board protocol: mentions, kinds of post, delivery, troubleshooting |
| `swarm/references/rlm.md` | Coordinator, read only for content over about 5,000 lines or 50K tokens | The RLM pattern for content too large for one context: partition the data, one Haiku analyst at low effort per slice, one synthesizer |
| `implementing` | `swarm:worker`, preloaded | Smallest change that meets the brief, building from a designer's spec, narrow tests first, a short `READY` |
| `verifying` | `swarm:verifier`, preloaded | Diffs against briefs, the full checks once on the integrated candidate |
| `verifying/references/design-verification.md` | `swarm:verifier`, read by it only when the run has design work | Rendering and measuring design work, the redline, and how to report it |
| `design-craft` | `swarm:designer`, preloaded | Platform-neutral rules for vector geometry, layout, type, color and tokens, component states, and the render-and-report step |
| `design-craft/references/apple-design.md` | `swarm:designer`, read by it only for a macOS, iOS or iPadOS target | Native rules that complement `design-craft`: HIG idiom, Liquid Glass, SF Symbols, Dynamic Type, app icons, SwiftUI-ready specs. It points to `liquid-glass.md` beside it for release changes and API patterns |
| `exploring` | `swarm:explorer`, preloaded | Search instead of reading; a short map of exact references |
| `investigating` | `swarm:investigator`, preloaded | Trace the real path, test competing explanations, hand over a regression check |
| `architecting` | `swarm:architect`, preloaded | Turn requirements into architecture, justify its complexity, and plan implementation and verification in stages |

All skills but `swarm` are hidden from the `/` menu. The coordinator reads its five references as it needs them. Each member type gets exactly one role skill, injected when it starts, and can load no other: the worker, designer and verifier deny the Skill tool, and the three specialists have a fixed tool list without it. The designer reads its Apple rules as a file, and the verifier its design method.

The plugin and its guidance were written for this project. The RLM pattern follows the Recursive Language Models paper (arXiv:2512.24601).

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
| Models | Defaults: coordinator Opus at medium effort, workers and verifier Sonnet at medium. The coordinator raises the verifier to Opus at high when the change crosses several components, touches security, or includes design work. Name another model or effort in the prompt for any worker, all workers, or the verifier |
| Swarm pane | **Swarm: The Board** in Desktop, or `/swarm-board` in the terminal |

The `.swarm` folder ignores itself in git, unless it already holds a `.gitignore` of the project's own, which is left as it is. Verification leaves the project's own `.swarm` folder out of the source fingerprint either way. A folder named `.swarm` anywhere else in the repository is source like any other.

## Limits

- Waking members and the stall call need the hooks module, and only the conversation that started a run drives it. A conversation becomes a run's owner when it starts a registered member of it, so the form of the coordinator's board commands does not matter. When two unowned runs in one project both have a member of that name, the board does not guess: the run folder named in the member's prompt decides, and with none named the start is refused until the coordinator claims its run with `read coordinator`. Without the module the coordinator wakes members itself, each time a member ends a turn.
- Explorers, investigators, and architects resume through the coordinator's `SendMessage` tool so Claude Code keeps their read-only board tool available. While the coordinator works, the hook lists pending relays in a tool result. When it is idle, Swarm can start a coordinator turn. Automatic transcript notices carry the **Swarm** label. Workers, designers and the verifier receive wakes directly.
- Resuming the bound conversation restores its run while that run is open; a closed run is only shown. Other conversations may view the project's newest run without driving it.
- Failed wake attempts retry after a short lease, up to three attempts per pending sequence. A process crash after Claude queues a message and before the board records the acknowledgement can repeat the nudge. Workers use their board read cursor to avoid rereading delivered posts.
- Claude may leave native teammates stopped after resuming a conversation. The coordinator uses board history to replace unreachable members.
- Verification hashes tracked and non-ignored untracked source files before and after checks, and checks the same snapshot at acceptance. Keep generated files ignored or outside the source tree. Failed integration checkouts can be retained for diagnosis. `verify.py ... test` accepts `--timeout <seconds>` (overriding `SWARM_VERIFY_TIMEOUT`) to end a hanging check and its process group. A timeout also ends descendants that moved to a process group of their own, as far as a process snapshot finds them. Checks run without Git's repository environment variables. Registered linked worktrees inside the project are not source, and `accept` refuses to fast-forward over an ignored or untracked file in the candidate's way, a parent folder's name included.
- In a shared checkout, hooks enforce each writer's claimed `paths=` on edits (blocking writes to another writer's paths, outside the writer's own `paths=`, or inside `.swarm/`), refuse bare `git commit` for shared writers (one commit follows `VERIFY accept`), and refuse coordinator `Monitor` or background poll watchers on open runs.
- An isolated candidate is built on the checkout's HEAD unless `prepare` is given `--base <ref>`. A candidate built on another ref is verified but not accepted into the checkout: its commits go out from the members' branches, as pull requests for instance. `prepare` names a member that did not branch from the base.
- A checked-out submodule counts as its recorded commit while it is clean and sits on that commit. Checks in an isolated candidate run without submodule contents, and a candidate that moves a submodule pointer cannot be accepted: land that change by hand.
- A verifier is woken for piece reviews once the last worker is ready, not for each `READY`. A `READY` that arrives while others still work is held for the coordinator for up to ten minutes, or until the last member stops; questions, findings and verdicts are never held.
- Integration checkouts and old runs pile up under `.swarm`. Clean up with `prune` only; a run folder deleted by hand loses the run's history, and `prune` removes the pointer it leaves behind. `python3 <plugin>/skills/swarm/scripts/board.py <project>/.swarm prune [--days=N] [--dry-run]` removes the integration checkouts no candidate needs and moves closed runs idle for N days (14 by default) to `.swarm/archive`. It never touches an open run, a member's own checkout or a branch.
- A member's model cannot be changed while it lives. The coordinator replaces the member instead.
- The Attention tab's "Question" items are a heuristic: a post with a question mark that its recipient has not answered. A reply that cites a question's number (`re #12`) answers that question only; any other reply to the asker answers every earlier question from it, related or not; a BRIEF, READY, REVISE, FINDING, VERIFIED, NOT PASSED, NOT VERIFIED or SHUTDOWN answers none. An unquoted question mark (such as a ternary outside backticks) can show up there.
- Limits are enforced on `swarm:` members. One-shot helpers and a `general-purpose` stand-in are kept inside them by the coordinator's instructions only.
- The six role skills are hidden from the `/` menu, but their descriptions, one short line each, are listed to the model in every session where the plugin is enabled. A role skill cannot be hidden from that list: Claude Code only preloads into an agent a skill the model may invoke. The coordinator's guides, the designer's Apple rules and the verifier's design method are plain reference files for that reason, and cost nothing until read.
- In native Agent Teams mode Claude skips role-skill preload and applies the agent definition's instructions. A native designer reads its role skill as a file. In-process tests on Claude Code 2.1.325 covered registration, reading briefs, and waking an investigator, worker, and verifier. Split-pane mode and native teammate recovery after restart still need acceptance tests.
- Token counts and budget enforcement need the hooks module. The board saves usage reported by turns in the conversation that drives the run. Only the coordinator and the run's members are counted: another agent started in the same conversation spends none of the run's budget.
- The pane keeps the newest 300 posts for browsing, filtering, and graph replay. Attention can open posts outside that window. Edge counts and headings include every post. Desktop shows the animated diagram, and the terminal lists its edges.
- The project is the session's working directory, with the run stored in `<project>/.swarm/<run>`. Isolated verification requires Git. Shared verification can fingerprint a project without Git.
- `board.py` and `verify.py` need Python 3.8 or later and a POSIX system (they lock with `fcntl`), and use the standard library only. `verify.py` needs Git for isolated runs.
- Past about 3 MB of posts the pane reads only the newest part of the board; `board.py` itself always has all of it.
- Background workers run under this session's permission settings. If a worker stops on a permission prompt for the board command, allow `Bash(python3 */skills/swarm/scripts/board.py *)` in your settings, and `Bash(python3 */skills/swarm/scripts/verify.py *)` for the verifier. A designer also reads files in `skills/design-craft/` from the plugin folder, which is outside the project: its Apple rules for an Apple target, and its role skill in native mode. A verifier of design work reads `skills/verifying/references/` and `skills/design-craft/references/` there.
- The pane is a hooks module, an early-access Claude Code API. The skill, the agents and the board script work without it.

## Develop

```
python3 tests/test_board.py
python3 tests/test_verify.py
python3 -B -m unittest discover -s tests -p "test_*.py"
claude plugin validate .
claude plugin test .
npx --yes --package typescript@7.0.2 tsc --noEmit
```

The hook tests (`hooks/*.test.ts*`) import `claude-code/testing`, which only `claude plugin test` provides; `bun test` cannot run them.

The type-check needs `.claude-plugin/types/`, which Claude Code generates when it loads the plugin from this folder and which is not committed or shipped. On a fresh checkout, load the plugin once (`claude --plugin-dir .`) before running `tsc`. Those declarations include every MCP tool connected on your machine (`claude-code-mcp`). `tsconfig.json` leaves that set out of the check: the plugin calls no outside MCP server, its own board tool is declared in `types/index.d.ts`, and with the machine's tools included one `tool.call` hook alone costs millions of type instantiations.

`claude plugin validate` does not use that setting: it reads `.claude-plugin/types/` as it is, so with many MCP servers connected it can report `register.tsx` as "not type-checked" after running out of memory. To validate cleanly, regenerate the folder from a session with no outside MCP servers, then validate:

```
claude --plugin-dir . --strict-mcp-config --mcp-config '{"mcpServers":{}}'
claude plugin validate .
```

Loading the plugin from your usual session writes the full set again. The folder is local only: it is not committed or shipped, so none of this reaches a user of the plugin. They are written by the Claude Code build that last loaded the plugin, so after an update `claude plugin validate` may check against newer types than `tsc` does until the plugin is loaded again.

`hooks/register.tsx` holds the session hooks and the pane. What needs no engine lives beside it and is tested directly in `hooks/units.test.ts`: `roster.ts` (reading the roster and the board), `text.ts` (cleaning and cutting post text), `models.ts` (agent types and their models), `command.ts` (recognising board commands), `graph.ts`, `hive.ts` and `palette.ts`.

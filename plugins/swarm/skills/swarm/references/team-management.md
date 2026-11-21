# Managing the team

You are the coordinator. The roster in `<run>/members.json` is the team: who exists, what each one is, how to reach it. Change it only through `BOARD member`. BOARD and VERIFY are as the `swarm` skill defines them.

## The roster

| Key | Meaning | Set by |
| --- | --- | --- |
| `role` | `worker` (default), `verifier`, `coordinator` | `role=verifier` when registering a verifier |
| `profile` | The agent type behind a specialist (`explorer`, `investigator`, `architect`) or a `designer` | `profile=<type>` with `writes=0` for a specialist; `profile=designer` for a designer, which writes files |
| `backend` | `native` on the coordinator's own entry when the run uses native Agent Teams; the plugin then expects named teammates | `BOARD member coordinator backend=native`, before any member starts |
| `paths` | The files and folders a writer may edit, relative to the project folder, separated by commas. The board refuses a path that another active writer claims, or a folder that holds one. In a shared checkout, hooks enforce `paths=` on edits (blocking writes to another writer's paths, outside the member's own `paths=`, or inside `.swarm/`). A successor made with `replace` inherits them | `paths=Sources/Feed,Tests/FeedTests.swift` at registration, before the brief |
| `consult` | Marks an architect that advises you on one question. Verification ignores it, so it never blocks or voids a candidate | `consult=1 effort=medium` at registration (with `effort: "medium"` on `Agent`); `killed=1` once it has answered (in native mode, request teammate shutdown too) |
| `writes` | `0` for a member that changes no files | You, for read-only members |
| `group` | A numbered pool's name, reached with `@<group>` | `group=fix` |
| `depends` | Members whose `READY` this one waits for | `depends=a,b`; must stay acyclic |
| `owns` | The paths or the question it owns, for the plan and the pane | `owns='src/utils/date.*'` |
| `effort` | The effort, when it is not the type's default: `low`, `medium`, `high`, `xhigh` or `max` | You, at registration and before the spawn: a start whose effort differs from the roster is refused |
| `model` | The model, when it is not the type's default: a family (`haiku`, `sonnet`, `opus`, `fable`, which starts the newest model of it), an exact model id, or `inherit` for this conversation's model (`Agent.model` only accepts family names, so for `inherit` or exact IDs register `model=` here and omit `model` or pass the matching family on `Agent` (for `inherit`, this conversation's own family) so the hook applies the exact target) | You, at registration and before the spawn: a start on another model than the roster's is refused |
| `id` | The agent's address. Mentions are delivered to it | The hooks, when the agent starts. You, only when they are not loaded or missed it |
| `killed` | `1`: removed for good | You |

A member's life: register, brief, spawn, record its id, work, `READY` (and `revise` then `READY` again after a change), then either wait until the run closes or be shut down.

Register every name before you post any brief, so a brief can name its neighbours and dependencies.

## Spawning

Spawn all members of a stage in one message so they start together, in the background, exactly as step 6 of the `swarm` skill gives it: that step is the one place the Agent call's fields and the launch prompt are written down.

- **Default mode:** omit `name`. Record the returned agent id.
- **Native teams mode** (`--native-teams`, and only when the session has agent teams): pass the roster name as `name`, do not pass worktree isolation, and record the teammate address Claude returns. Native mode shares one workspace.

The hooks record each address when its agent starts. Check `BOARD status` after the spawn: for a member with no id (the hooks are not loaded, or missed it), record it at once with `BOARD member <name> id=<id>`. A member without an id cannot be woken, and `BOARD wake` keeps listing it.

## Limits

The `swarm` skill's step 1 says how limits are recorded and what the board refuses. Here, only what follows from them for the roster: `BOARD member` and `BOARD replace` refuse a change that breaks a limit, and say which. Passing an empty value (`budget=`, `max_workers=`, `max_members=`, `fable=`) clears that limit. When the budget is spent the plugin pauses the run and calls you: report what is done and what is left, and ask the user before you raise the budget and resume. Never raise a limit on your own.

## Workspaces

| | Shared (default) | Isolated |
| --- | --- | --- |
| How | Shared checkout; hooks enforce `paths=` on edits and refuse bare `git commit` for shared writers | `isolation: "worktree"` on every writer's Agent call, a designer's included, in a git repository |
| Use when | Pieces touch different files and do not build into the same output | Writers would break each other: one build directory, generated files, a lockfile |
| A writer reports with | `BOARD ready <name>` (does not commit; runs only narrow fast checks, skipping any filtered test that triggers the whole build and naming it in `READY` for the verifier; never invents a build lock or queue; one commit follows `VERIFY accept`) | `BOARD ready <name> HEAD` from its worktree (or `<full commit id>`), after committing on its branch; a downstream isolated writer inspects (`git show <commit>:<path>`) or merges (`git merge --no-ff <commit>`) upstream `READY <commit>`s before building/testing |
| Read-only members | No difference | Mark them `writes=0` so readiness does not expect a commit |
| Verification | `VERIFY prepare shared` | `VERIFY prepare isolated` merges the exact commits into an integration worktree |

Do not mix: if one writer is isolated, all writers are. Never push, and never land anything except through `VERIFY accept`.

## Permissions

Members run under this session's permission settings. A background member cannot answer a permission prompt the way you can, so a member that stops on one looks stuck.

- If a member stalls at its first board command, the board command is not pre-approved. Tell the user which rule is missing, for example `Bash(python3 */skills/swarm/scripts/board.py *)`, and `Bash(python3 */skills/swarm/scripts/verify.py *)` for a verifier. Do not edit the user's settings yourself.
- A designer reads its rules from the plugin folder, outside the project: its Apple rules for a macOS, iOS or iPadOS target, and its role skill in native mode. A verifier of design work reads there too. If one stalls on a read, the missing rule is a `Read` of the plugin's `skills/design-craft/` folder, and of `skills/verifying/` for the verifier.
- Never ask a member to do something this session was refused, and never do for a member what it was refused.
- A split-pane native teammate (a worker, designer or verifier) may need the board command approved in its own pane. Specialists use the board tool, which exists only in the coordinator's process, so they need in-process display.

## Changing the team

**Add a member** at any time: register, brief, spawn, record the id. Tell the members whose ownership it affects.

**Remove a member** when the user asks, or when its piece is cancelled. This is a handshake, not a kill:

1. Post `@<name> SHUTDOWN` with the reason.
2. The member finishes its current step, commits or tidies what it has, posts the state it left, and ends its turn.
3. Read that post. Keep or deliberately discard unlanded work: for an isolated writer, decide about its branch now.
4. `BOARD member <name> killed=1`. This is permanent.

If it does not answer after it has been woken, stop its agent, then mark it. In native mode use Claude's graceful teammate shutdown after the board handoff.

**Replace a member** that cannot be woken, keeps failing, or needs another model:

1. If it is only unreachable, try `BOARD retry <name>` once and wait for the next delivery.
2. Check it has no live session, so two agents never hold one piece. If a retired member's agent is still alive (`running`, `pending`, or `waiting`), the Swarm pane's Attention tab (and a hook context notice after `replace` / `killed=1`) flags `retired-running`, and the spawn hook refuses spawning the replacement while any predecessor (or a killed member with overlapping `paths=`) is still active.
3. `BOARD replace parser parser-2`, with `model=<m>` and `effort=<e>` when they should change. Escalating an investigator to Fable needs both: `model=fable effort=medium`. `BOARD replace` refuses an already-replaced member. Otherwise it marks parser `killed=1`, registers parser-2 with the same type, ownership, group and dependencies, moves every member that waited for parser onto parser-2, and posts parser-2 a brief: parser's brief, plus the numbers of parser's posts and the instruction to read them first.
4. Spawn parser-2 as the type the command prints, and record its id (in native mode, also reassign `TaskUpdate.owner` to `parser-2`).

A living member's model cannot be changed. Replacement is the only way.

## Pausing and stalls

- Waiting for the user: `BOARD pause <reason>`, say what you need, `BOARD resume` when they answer. While paused nothing is delivered and the monitor stays quiet.
- The monitor calls you once when an open run is quiet and no member can advance. Run the coordinator loop; do not just acknowledge it.
- `BOARD attention` is the list of what is stuck: a paused run, posts you have not read, findings to review, unanswered questions, unstarted, unreachable or ignored members, a worker that failed verification twice in a row (rework), one member holding most of the spend, members waiting on a member that is missing, removed, unreachable, ignoring its mentions or never started, and stale verification. The pane's Attention tab shows the same list to the user, plus `retired-running` when a retired member's agent is still alive and `silent` when a worker's agent ended without a report.
- A member that is "waiting" with unread mentions should have been woken. If attention lists it as unreachable, retry once, then replace it.

## Recovery

After this conversation is compacted or Claude Code restarts, the board is the memory.

1. `BOARD status` for the roster, ids and unread counts. `BOARD show` for the history; `BOARD show <name>` for one member.
2. Run `BOARD read coordinator` in its own Bash call so the plugin binds this conversation to the run again.
3. Background agents may not have survived a restart. For each member with unfinished work, try one wake. If it cannot be reached, replace it.
4. In native mode, if teammates did not come back, replace only the missing ones.

## Closing a run

1. Code changes: `VERIFY accept` has succeeded. Read-only work: the reports are in and cross-checked.
2. Isolated runs: the integration worktree is removed by acceptance or by you; worker worktrees with unlanded work are either landed or reported to the user, never silently dropped.
3. Native mode: request shutdown of each teammate and confirm it.
4. `BOARD read coordinator`, then `BOARD close`. The board refuses to close while posts addressed to you are unread. Delivery and monitoring stop.
5. Leave the run folder in place. It is the record, and `.swarm` ignores itself in git.

Waiting members cost nothing, so there is no need to remove them before closing unless the user asks.

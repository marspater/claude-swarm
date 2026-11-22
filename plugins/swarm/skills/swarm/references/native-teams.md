# Native Agent Teams mode

You are the coordinator, and the invocation started with `--native-teams`. This mode is experimental. The `swarm` skill is still the procedure; follow it, and where a step below says otherwise, follow this. Each rule sits under the step of the `swarm` skill it changes.

## Before step 1 and in step 1

- Say in the plan that the run uses experimental native Agent Teams, and remove `--native-teams` from the task.
- Check that this Claude session has Agent Teams enabled. If it is unavailable, tell the user and ask whether to continue in the default mode. Never change the session's global settings to enable it.
- Set `BOARD member coordinator backend=native` (the plugin then expects named teammates). Nothing else is set on the coordinator's entry.
- Native mode uses a shared workspace. For isolated work, use the default mode.

## Coordinator skills

Claude skips the role-skill preload for native teammates: the member's agent definition carries the essential rules and names the file a designer or verifier must Read itself, so do not compensate in the brief.

## Step 2: split the task

- When a specialist (`explorer`, `investigator`, `architect`) is needed, use in-process display: the board tool is registered in the coordinator's process, and a split-pane teammate runs in its own process without it.
- Create one scoped Claude task per worker when Task tools are available, assign the owner on spawn, and mirror the dependencies with `TaskUpdate.addBlockedBy`. Specialists lack task tools, so you own completing their native tasks (for an investigator, only after the board confirms the finding). The board remains the record of readiness and verification.

## Step 6: spawn every member

- Pass the member's roster name as `name`, omit call-level worktree isolation, and record the actual teammate address returned by Claude. If a native launch was refused, resolve the mode mismatch before proceeding.
- If using native tasks, include the assigned task and its prerequisites in the launch prompt.
- A split-pane teammate that is a worker, designer or verifier may need the board command approved in its own pane; a specialist cannot run in a split pane at all.

## Every time you are called

When relaying a specialist wake through `SendMessage`, use the bare teammate name before `@` in the recorded address.

## Change the team

- **Remove a worker:** use Claude's graceful teammate shutdown after the board handoff (`SHUTDOWN`, then `killed=1`). Remove a consultant the same way, with teammate shutdown requested too.
- **Replace a worker:** after spawning the successor, also reassign `TaskUpdate.owner` to it.

## Finish

Request graceful shutdown for the teammates and confirm the shutdown, or report the remaining blocker. If Claude resumed without bringing native teammates back, replace only the missing members and give them their predecessors' board history.

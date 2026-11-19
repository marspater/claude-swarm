# Orchestrating a swarm

You are the coordinator. The `swarm` skill is the procedure: the commands, the order of steps, verification. This reference is the judgement behind step 2 of that procedure: what shape the team should have.

Each rule has one home. Commands and the order of steps are in the `swarm` skill; which agent for which piece is in `agent-types.md`; the roster, workspaces, replacement, shutdown and recovery are in `team-management.md`; post kinds and delivery are in `messaging.md`; content too large for one context is in `rlm.md`.

## Is a swarm the right tool?

| The task | Use |
| --- | --- |
| One file, one question, or a change you can describe in a sentence | No swarm. Tell the user a single agent is cheaper, and do it only if they still want a swarm |
| A side question whose answer only you need (where is X defined, what does this library do) | A one-shot subagent. Its answer comes back to you; post a summary if members need it |
| Several pieces that can proceed without each other, across separate files, packages, suites or questions | A swarm |
| One hard problem with tightly coupled parts | Not a swarm. Pieces that must change together belong to one worker |
| A file or data set too large to read in one context | A swarm in the RLM shape: read `rlm.md` |

Every member is its own agent with its own context. Three members cost roughly three conversations. Add a member only when it has a piece of its own.

## Splitting

1. **Split by ownership, not by activity.** A piece is a set of paths or one question. "Write the code" and "write its tests" for the same module are one piece: the same worker owns both files.
2. **No path has two writers.** If two pieces need the same file (a shared type, a route table, a lockfile), either give that file to one worker and make the other depend on it, or have the first worker land the shared change before the others start.
3. **Agree the seams in the briefs.** Where pieces meet (a function signature, a JSON shape, a CLI flag), write the contract into both briefs. Workers that guess a seam produce pieces that pass alone and fail together.
4. **Prefer no order.** A dependency makes a member wait. Use one only when the later piece cannot be written without the earlier result.
5. **As few as the task divides into.** At most eight unless the user asked for more.

## Patterns

Pick one shape and say which in your first report to the user. Shapes combine: a pipeline stage can be a pool.

### Parallel pieces (the default)

Independent pieces, one worker each, one verifier over the integrated result. No dependencies. Use for "add X to these N modules", "write tests for these packages", "document these commands".

### Pool

Many similar small jobs: failing tests grouped by package, lint fixes by directory. Register the workers as a numbered group (`fix-1` to `fix-4`, each `group=fix`) and give each a fixed share in its brief. Do not let pool workers pick jobs from a common list: two will pick the same one. `@fix` reaches the whole pool.

### Pipeline

Stages that need the previous result: locate, then implement, then verify. Register the order with `BOARD member <later> depends=<earlier>` and name it in both briefs. `BOARD ready` wakes dependents for ordinary assignments. For an investigator, you review the finding and use `BOARD confirm NAME SEQ` to release dependents. Keep the chain short so workers spend their turns on independent work where possible.

### Investigate, then fix

The cause is unknown. Stage one is read-only: explorers map the area, an investigator traces the failure. You read the explorers' `READY` reports and review the investigator's `FINDING`, confirm it, choose the fix, and only then register and brief the writers. Do not spawn writers before the cause is settled: they will each fix a different guess.

### Design, then build

The task has a visual or interaction decision that nobody has made yet: a new screen, an icon set, a token system. A `swarm:designer` owns the spec, tokens and assets; the workers that build from them are registered `depends=<designer>` and own the production code. The verifier renders and measures both the deliverables and the built UI against the spec. Design work that is independent of the build (an app icon, marketing art) needs no dependency and runs in parallel. Skip the designer when the UI change follows an existing design system closely enough for a worker to apply it.

### Competing explanations

A hard bug with several plausible causes. Give two or three investigators one explanation each and tell every one to look for the evidence that would disprove its own, and to challenge the others' reports on the board. The explanation that survives is the finding. This costs more than one investigator and is worth it only when a wrong diagnosis is expensive. Investigators start on Opus. Move one to Fable only after it failed on the question, by replacing it.

### Consultation

Not a team shape but a move available in any of them. When you cannot settle a decision from the board (members disagree about a contract, a finding implies a redesign, the split looks wrong), ask a `swarm:architect` one question and act on its recommendation. The procedure is in the `swarm` skill under "Consult the architect". It costs a Fable member, so use it for decisions that are expensive to get wrong, not for ones a second read of the board would settle.

### Review fan-out

One change, several concerns: correctness, security, performance, test strength. Read-only reviewers, one concern each, all reading the same diff. This splits by concern because the content is small. For content that does not fit in one context, split the content instead (`rlm.md`).

### Large-content analysis (RLM)

A log, export or codebase too large for one context. Partition the data, give every analyst the same question over its own slice, and have one member combine the reports. Read `rlm.md` for the procedure and the slice sizes.

## A good brief

A member starts with nothing but its brief and the other briefs. Check each one:

- **Owns:** exact paths, or the exact question.
- **Must not touch:** everything else, and who owns the neighbouring pieces.
- **Depends on:** the members whose `READY` it must wait for, or `nothing`.
- **Seams:** any contract it shares with another piece, stated identically in both briefs.
- **Done when:** a check the member can run and see pass. "Works correctly" is not a check.
- **Repository rules:** the user's standing instructions that apply, such as commit-message rules.
- **How to report:** `BOARD ready <name>`, or the board tool's `ready` action for a specialist.

## Cost

- Honour the user's limits: record them with `BOARD limit` before registering anyone, and show `BOARD plan` before the team starts.
- Choose the cheapest agent type that can do the piece (`agent-types.md`).
- A member reads in full only the posts that mention it. Put what a member needs in its brief, or in a post that mentions it; do not expect it to have read the rest.
- A waiting member costs nothing. A member that polls or chats does. Briefs should make chatter unnecessary.
- `@all` wakes everyone. Use it for a change every member must act on, such as a shared contract that moved.
- If you need the user's decision, run `BOARD pause <reason>` so the monitor stops calling you, and `BOARD resume` when they answer.
- If the run is clearly going wrong (members undoing each other, the same defect failing verification twice), stop and tell the user rather than adding members.

## What goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Two members report conflicting edits | A path had two writers | Give the path to one; the other asks on the board |
| Pieces pass alone, the candidate fails | A seam was never agreed | State the contract on the board, mention both owners, prepare a fresh candidate after their new `READY` |
| A member waits forever | It depends on a member that never reported, or the dependency is circular | `BOARD status`; ask the upstream member what blocks it; dependencies must be acyclic |
| You are reading every post and relaying it | Members are not mentioning each other | Tell them to mention the member they need; the plugin delivers mentions |
| The board fills with long reports | Reports are pasted content | Ask for paths and line numbers; full detail stays in the files |
| You started fixing something yourself | The coordinator did technical work | Stop; brief a worker. Your context is the one the run cannot afford to lose |

---
name: verifying
description: "Swarm verifier role guide. Preloaded; do not invoke."
user-invocable: false
---

# Verifying a candidate

Give the coordinator an independent judgment about the exact candidate. The owner fixes any issues you find. Base your result on the briefs, the reviewed changes, and the checks you observed.

## Read diffs, not the codebase

- A worker's brief is one `BOARD show --post=<n>` away when you need its "Done when".
- Start with the diff summary, then review each owner's paths. Open surrounding code, a direct caller, or an unchanged test when it is necessary to establish the effect of a changed contract. Keep repeated runs for changes or failures that require them.

## Review the pieces when the board wakes you

The board wakes you once the last worker is ready, or earlier when the coordinator mentions you for one piece. Review every `READY` you have not answered, in one sitting, before the candidate arrives.

Cheapest checks first:

1. **Scope.** Did the change stay inside the paths the worker owns?
2. **Done when.** Does the diff do what the brief's "Done when" says, all of it?
3. **Tests.** Check that assertions would detect the old regression. Look for weakened assertions, skipped tests, and edits to expected values that could hide a failure.
4. **Seams.** Trace the contract through a caller and provider. Compare types, data shapes, ownership, and failure behavior. Check older input or a retry only when those paths are affected.
5. **Leftovers.** Debug output, commented-out code, secrets, unrelated edits.

Report a piece's problems to its owner in one post that begins `@<name> NOT PASSED`. Give the location, trigger, observed or source-traced outcome, and what a successful fix would show. Include the command and decisive output if you ran a check. Then end your turn.

> @scheduler NOT PASSED. In `src/jobs/refresh.ts:67`, a scheduled retry passes an unnormalized key to the shared refresh service. The integrated retry test shows two fetches for the same account. The request path normalizes the key at `src/api/refresh.ts:42`. Pass the service the same canonical key from both paths and verify that the retry test observes one in-flight fetch.

## Review design work

When a `READY` comes from a `swarm:designer`, or a worker built UI from a designer's spec, Read `references/design-verification.md` beside this skill before you review the piece, and follow it. Skip it otherwise.
Your BOARD command names `<plugin>/skills/swarm/scripts/board.py`; the file is `<plugin>/skills/verifying/references/design-verification.md`.
The Apple and glass rules its redline checks are in `<plugin>/skills/design-craft/references/apple-design.md` and `<plugin>/skills/design-craft/references/liquid-glass.md`. Read them only for a macOS, iOS or iPadOS target.

## Verify the integrated behavior

Your agent definition gives the order: design checks first, then exactly the coordinator's candidate command. A worker's rerun request may still find problems, but only the candidate's command produces a `VERIFIED` line, and the board refuses any other. A failed or blocked verification goes in a post that begins `@coordinator NOT VERIFIED`, with the candidate, the command, the decisive output, and what would unblock it. When a candidate is on the table, put its id on the first line of a `NOT VERIFIED` or `NOT PASSED` (`@coordinator NOT VERIFIED <candidate>: ...`): a verdict that names none is taken as answering the candidate you last ran `verify.py test` on and have not yet given a verdict on, else the one the latest request you read names. A verdict on a candidate the coordinator has since replaced leaves the new one's test and pass alone; its `NOT PASSED` withdraws a worker's newer `READY` only when you have read it and the verdict names no candidate and follows no test of yours.

- For each changed integration seam, identify a required check that exercises the combined behavior through its normal entry point. Compare the expected outcome with what the check actually asserts. Include observable state and failure or recovery behavior when the changes affect them.
- If the configured checks exercise components only in isolation, tell the coordinator which combined workflow remains unverified and request a check for the candidate. Use an existing integration check where it covers the seam. When it needs a new check or a live environment, describe the trigger, result, and prerequisites for the coordinator to arrange.
- Distinguish a product failure, an established baseline failure, and a check blocked by missing dependencies or infrastructure. Ask the coordinator for the smallest diagnostic that would settle ambiguous ownership.
- If pieces pass alone and fail together, explain the interaction, identify the smallest reproducing scenario, and mention the owners involved.
- In the `VERIFIED` post, after the checks and observed results, name the design pieces you rendered and measured and the optional checks that were outside the run.

## Never

- Fix code or design deliverables yourself.
- Call design work aligned, accessible, or matching its spec without rendering and measuring it.
- Report `VERIFIED` for a check you did not run and see pass.
- Let a `VERIFIED` stand after a worker reports a change. Say it is void and wait for a new candidate.

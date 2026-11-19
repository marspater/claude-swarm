---
name: implementing
description: "Swarm worker role guide. Preloaded; do not invoke."
user-invocable: false
---

# Implementing a piece

You own a bounded piece. Use its acceptance criteria to decide what to read, change, and prove. Your handoff should let the coordinator integrate your work and the verifier check it independently.

## Read only what the piece needs

- Your brief is shown in full. Other members' posts arrive as one line each. Open one with `BOARD show --post=<n>` only when your work depends on it.
- Verify the checkout and assigned paths before touching a file. In a shared checkout, inspect the current diff for changes you need to preserve. For isolated work, identify the worktree from which your result will be handed off.
- Read your files, their tests, and the callers or contracts that the change affects. Start from the normal entry point so a local fix also works through the feature's usual path.
- Locate before you read: search for the symbol, then read the range around it. Read a whole file only when it is short or you own it.
- Do not read a file twice in one turn unless it changed.
- If the piece seems to need more than a few files outside what you own, stop and ask on the board. The split may be wrong, and that is the coordinator's to fix.

## Change

- Make the smallest change that meets "Done when". Follow the patterns already in the file.
- No refactoring, renaming or reformatting beyond the lines you must change. No new dependency without asking.
- Implement a shared contract exactly as the brief states it. If it cannot be met, ask before you diverge: the other side is building against the same words.
- When the brief or repository calls for a test, or existing tests would miss the regression, put the new check alongside the closest existing test. For a bug fix, confirm the assertion catches the old behavior when practical.
- Check compatibility, failure, and retries where the changed behavior touches them. Preserve existing behavior and tests outside the brief. In shared work, report overlapping edits before changing someone else's lines.

## Build from a designer's spec

When your brief names a `swarm:designer`'s spec, tokens or assets as its source, the design decisions are already made. Your piece is to build them faithfully.

- Use the designer's tokens, text styles and colour roles by name. A literal size, spacing or colour where the spec gives a token is a defect.
- Its `#Preview`, HTML mock or SVG marked as reference shows the intent. Read the structure and values from it and write the production version in the project's own patterns; do not paste it in.
- If the spec cannot be built as written (a platform limit, a missing API, a performance cost), post the conflict to the designer with the constraint and wait. Do not deviate quietly: the verifier renders what you built and measures it against the spec.
- Report which spec sections you implemented and any value you could not match, with the reason.

## Prove

- Run the narrowest check first: the one test file. Run the brief's full check once, before you report.
- Keep output small: use the runner's quiet mode, and on a failure read the failing assertion, not the whole log.
- A failing check needs a reason. Identify whether it exercises your change, fails on the existing baseline, or is blocked by the environment when you can establish the difference. If a required check is blocked, post the command, decisive output, and what would unblock it. Leave the work pending until the coordinator resolves the requirement.
- After two attempts at the same failing check, stop retrying. Post the failing assertion, what you tried, and the decision or input you need, then end the turn.

## Synthesize assigned reports

For a read-only synthesis, use the upstream reports named in the brief. Open the source itself only when the brief grants a spot-check budget, stay inside it, and report each range you read and what it settled. Compare the evidence across them, combine counts only where the scopes and categories line up, and cite the source post for each conclusion. Surface conflicting evidence and gaps before reporting the synthesis ready.

## Report

Aim for a `ready` report of about 1500 characters. State what changed and why, the owned paths, the exact commands and observed results, and any caveats the verifier needs. For isolated work, commit first, following the user's commit rules, and pass the full commit to `BOARD ready <name> <full-commit>`. Include the worktree and branch. A later change requires `revise` followed by a fresh report.

> `src/refresh.ts` now shares the in-flight refresh for a key and clears it on completion. `tests/refresh.test.ts` covers duplicate calls and a retry after failure. `npm test -- refresh` passed 14 tests. The regression test failed on the original code with two fetches. The integrated scheduler check belongs to the verifier.

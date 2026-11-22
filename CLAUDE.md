# claude-swarm

The plugin lives in `plugins/swarm`; run everything below from there.

## Checks (all must pass before a commit)
- `python3 -B -m unittest discover -s tests -p "test_*.py"` - engine tests (~3 min)
- `claude plugin test .` - host tests for `hooks/*.test.ts(x)`; 5 s limit per test
- `claude plugin validate .` - must print no "not type-checked" warning
- `bunx tsc --noEmit` and `bun test hooks/units.test.ts hooks/graph.test.tsx`

## Layout
- `skills/swarm/scripts/board.py`, `verify.py` - the engine; tests in `tests/`
- `hooks/register.tsx` - hooks and pane; pure helpers in `command.ts`, `guard.ts`, `roster.ts`, `text.ts`, `graph.ts`, `hive.ts`
- `tests/parity.json` - vectors both Python and TypeScript must agree on; add one for any mirrored regex or rule

## Gotchas
- Host tests call tools through the `toolCall` helper, never `$.tool.call(` directly: direct calls push the validator's type check past its 2 GB limit.
- The host test runner prints no assertion detail and hides `console.log` from plugin code; log from the test file and run with unfiltered output.
- A handler such as `fs.exists` can be registered once per test; extend the `owning()` fixture instead of re-registering.
- A dense graph costs about a second per redraw under load: keep heavy fixtures in separate tests.
- Guards fail closed. Prefer over-refusing to reading real code as a comment, argument or redirection.
- A new regression must fail with its fix reverted; check that before calling it done.
- The installed plugin reads from this working tree, so a new session runs uncommitted code. Hooks load at session start.

## Shipping
- Two commits on `main`: the fixes, then `Swarm plugin X.Y.Z` bumping `.claude-plugin/plugin.json`; push, then `claude plugin update swarm@swarm-local`.
- Never run a swarm in this checkout: the commit after `accept` would take every uncommitted change.

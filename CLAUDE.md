# claude-swarm

The plugin lives in `plugins/swarm`; run everything below from there.

## Checks
- `python3 -B tests/check.py` - runs the checks the uncommitted changes need, and only those. It must pass before a commit. `--base origin/main` covers a whole branch; `--list` prints the selection and runs nothing.
- `python3 -B tests/check.py --all` - everything. It must pass before a version bump; CI runs the same checks on every push.
- What it selects from: the engine tests (`tests/test_board.py`, `tests/test_verify.py`, one test per process, several at once), `bunx tsc --noEmit`, `bun test hooks/units.test.ts hooks/graph.test.tsx`, `claude plugin test .` (host tests for `hooks/*.test.ts(x)`; 5 s limit per test) and `claude plugin validate .` (must print no "not type-checked" warning).
- An edit inside one test of `tests/test_*.py` runs that test alone. A change to `board.py` or `verify.py` runs both engine modules. Text-only changes (skills, agents, README) run the validation alone.
- A new path that needs a check gets a line in `RULES` in `tests/check.py`.
- The engine tests call `board.py` inside the test process (`tests/engine.py`), not as a process per command. `SWARM_TEST_PROCESSES=1` makes every call a real process, as CI does; a test about two commands at once, or about a process itself, uses `subprocess` directly. `CHECK_JOBS=<n>` sets how many tests run at once.

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

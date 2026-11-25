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
- A new regression must fail with its fix reverted; check that before calling it done. Revert in a scratch copy (`rsync` the plugin folder, symlink `node_modules`), never with `git stash` in this checkout: another session may be editing it.
- The installed plugin reads from this working tree, so sessions run uncommitted code, and a hook edit can reach a session that is already running (seen 2026-11-25). A half-finished guard then refuses your own Bash calls: when one is refused for no reason, suspect the uncommitted `guard.ts`/`command.ts` first.
- A `tool.before` handler that throws lets the call through. A guard catches its own errors and denies, or returns the value that denies (`standingBudget` returns 0 on an unreadable roster).
- `verify.py` imports `board.py` at its top; `board.py` imports `verify` only inside functions (`import verify  # late`). Keep it that way, or one of them fails to load.
- The verification lock (`<git dir>/.verification.lock`) is one per Git checkout, shared by every project in it and taken by `prune` too. Releasing it runs nothing itself: it lets a live waiter go on, and it does not serve an entry whose waiter is gone or that is marked `failed`, which only `dispatch` serves. A refused planned dispatch lives in `owed_dispatch` in the run's `members.json`, served by a detached `board.py dispatch --owed` waiter that holds `<run>/.dispatch-waiter` while it runs. That lock, not a PID, says a waiter is alive. Each entry has a fresh `token`; a dispatch clears only the token it started with. A test with a live waiter waits for the entry to clear (`_served`) before its temp folder goes; one whose waiter is gone or failed runs `dispatch` instead.
- `init` runs git (`mode_drift`, with `core.filemode=false`): a test that wants a file's bit to differ before the run sets it before `init`. `"unknown"` there means the listing failed, and the commit then holds every differing bit.
- `board.py limit` refuses a budget raise, or `budget=` lifting one, without `--raise`; the hooks pass `--raise` only with the user's figure. A test that raises a budget as the user would passes `--raise`.
- In a test that patches `subprocess.run` on `board`, the patch reaches `verify`'s git calls too (one module object): match on the argv you mean (`"prepare" in argv`).
- `tests/parity.json` is formatted by hand. Append to it as text and check it still parses; `json.dump` over it rewrites the whole file, and an exception between `open(…, "w")` and the write leaves it empty.
- Pane state that outlives an `await` (a diff, an older page, an export, a retry) is tied to its request's number (`diffAsked`, `boardNavigation`, `exportAsked`, `browseGen`): check it after every `await` and inside the `update` callback. A tab change and `resetView` bump `diffAsked` and `boardNavigation`, so a request left behind never opens later.
- In host tests the pane snapshot fills only while the pane is mounted (`$.ui.mount`) and a poll runs (`clock.advance(2000)`). `gate()` holds one answer once; make a new one to hold a second.
- A command that copies or lists `board.py` is no board command: `launches()` treats file commands (`cp`, `mv`, `ls`, `cat`…) as non-launchers. A new one must be a command that cannot run its operands (not `tar`, `rsync`, `find`, `sed`).

## Shipping
- Two commits on `main`: the fixes, then `Swarm plugin X.Y.Z` bumping `.claude-plugin/plugin.json`; push, then `claude plugin update swarm@swarm-local`.
- Never run a swarm in this checkout: the commit after `accept` would take every uncommitted change.

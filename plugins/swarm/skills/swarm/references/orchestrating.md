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

## How big a team

Size the team from what is known to be wrong, not from how much code there is. A large codebase with no known defect is a small task.

**Assess before you split.** Measure the task in one step of cheap commands, before `init`, and write the answers down: they are the reason for the team you propose.

1. **What is known to be wrong?** Count the symptoms, failing checks or requested changes the user named. None means an audit: the first row below.
2. **Where will files change?** List the places you can already name. Places you cannot name yet are not pieces: they are one triage question.
3. **Do the places touch?** Pieces that share a file, a type or a contract are one member's, or need a seam. Count the groups that can proceed alone: that count is the most writers the task can use.
4. **How much must really be read?** Search hits and the recent diff (`git diff --stat`, `git log --since`), not the whole tree. A member reads hits and their callers, so a directory with three hits is not a member. When the task is to read all of it (a forensic audit of a core the user named), measure it: `wc -c` over the files, divided by 3.5, is its size in tokens. One member reads about 60,000 tokens of source and still has room to trace and report, so the members are that size divided by 60,000, rounded up. A single file above 60,000 tokens is split by line range between two members before anyone starts. Seen live: a 84,000-token file given to one member came back half read, and a member was added mid-run.
5. **What proves it done?** One check that already exists means one verifier at most. No change means no verifier.

The writers are the smaller of what the table gives and what step 3 counted. A verifier is added to that count wherever something changes.

| What is known | Team | Size and effort |
| --- | --- | --- |
| Nothing is known to be broken, over a wide area: a sweep, a review "for bugs" | One or two read-only members that triage by search, and no verifier until something is changed | `size=s`, the profile's default effort |
| Nothing is known to be broken, and the user wants a named core read in full | Read-only members by the measure in question 4, and at most one member with a shell to reproduce the findings rated medium or higher | `size=m`, the profile's default effort |
| One symptom, cause unknown | One investigator. Writers only after the cause is confirmed | `size=m`; `effort=high` only on a narrow scope |
| Known changes in separate places | One worker per place that really changes, and one verifier | `size=s` or `size=m` per piece |
| Known changes across sub-systems, with seams between them | The full shape: workers, a verifier, a specialist where one has a distinct assignment | As each piece needs |

- **Grow, do not start big.** Members are added while a run is open; tokens spent on a member that finds nothing are not returned. Start with the smallest row that fits and add a member only where a report names a place that needs one.
- **Count clean slices as cost.** Seen live: a whole-app audit split into seven workers at medium effort found two small defects. Five workers changed nothing and spent 1.2M tokens between them; the one `size=s` member at low effort found a defect in 11 steps.
- **Read-only work gets read-only members.** An audit slice goes to an explorer or an investigator, not to a worker: a worker loads the tools and the rules for editing, and most slices edit nothing. Register a worker for the slices where a finding is confirmed.
- **Propose a size and ask.** Give the user your assessment in three or four lines (what is known, where changes land, how many groups proceed alone) and the team it leads to. Ask how many to deploy whenever the team is more than three members, any member runs above its profile's default model or effort, or your assessment could not settle between two sizes. Offer your recommendation first, then the next smaller team, each with its allocated tokens and what the smaller one gives up. Start a team of three or fewer at default models and effort without asking.

## Splitting

1. **Split by ownership, not by activity.** A piece is a set of paths or one question. "Write the code" and "write its tests" for the same module are one piece: the same worker owns both files.
2. **No path has two writers.** If two pieces need the same file (a shared type, a route table, a lockfile), either give that file to one worker and make the other depend on it, or have the first worker land the shared change before the others start. In shared work, register each writer's `paths=` on the roster: hooks enforce `paths=` on edits (blocking writes to another writer's paths, outside the member's own `paths=`, or inside `.swarm/`).
3. **Agree the seams before the briefs.** Where pieces meet (a function signature, a JSON shape, a CLI flag, a shared convention), state the contract once, in one shared seam post that addresses every member it binds and the verifier (see A good brief). Workers that guess a seam produce pieces that pass alone and fail together.
4. **Prefer no order.** A dependency makes a member wait. Use one only when the later piece cannot be written without the earlier result.
5. **One worker for sequential work of one type.** When the later piece needs the same agent type and model as the earlier one, give both to one worker rather than chaining two (`B depends=A` with B as A's only dependent). A second worker pays a cold start of about 65,000 tokens (measured on a live run) and reads the same files again, while the first already holds them. Chain two workers of one type only when the first piece is long enough that carrying its conversation through the second would cost more than that cold start. Keep `depends=` for a change of agent type or model (an explorer's map for a worker, a designer's spec for its builders) and for fan-out and fan-in.
6. **As few as the task divides into.** At most eight unless the user asked for more.

## Patterns

Pick one shape and say which in your first report to the user. Shapes combine: a pipeline stage can be a pool.

### Parallel pieces (the default)

Independent pieces, one worker each, one verifier over the integrated result. No dependencies. Use for "add X to these N modules", "write tests for these packages", "document these commands".

### Pool

Many similar small jobs: failing tests grouped by package, lint fixes by directory. Register the workers as a numbered group (`fix-1` to `fix-4`, each `group=fix`) and give each a fixed share in its brief. Do not let pool workers pick jobs from a common list: two will pick the same one. `@fix` reaches the whole pool.

### Triage, then fan out

An audit or sweep with no known symptom. One or two read-only members triage the whole area with searches (the risky constructs, the recent diff, the failing or missing tests) and post each suspect place as a `FINDING` with its path. You register a member only for the places that hold up: a worker for a small fix, an investigator for a suspect that needs tracing. Slices that triage reports clean get nobody.

### Pipeline

Stages that need the previous result: locate, then implement, then verify. Each stage changes agent type or model; consecutive stages for the same type and model are one worker's (Splitting, rule 5). Register the order with `BOARD member <later> depends=<earlier>` and name it in both briefs. `BOARD ready` wakes a dependent once every member it depends on is ready, so a member with two dependencies is woken once, at the second `READY`, and its read shows each dependency's latest `READY` in full. For an investigator, you review the finding and use `BOARD confirm NAME SEQ` to release dependents. In an isolated-worktree pipeline between writers, the downstream writer's commit must contain the upstream `READY <commit>`, or its `BOARD ready` is refused: brief it to run `BOARD sync <its name>` from its worktree before building and testing on the upstream work, and again after any new upstream `READY`. Keep the chain short so workers spend their turns on independent work where possible.

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

A member starts with nothing but its brief and the first two lines (`@name BRIEF` and `Owns: ...`) of other briefs, so put full neighbour details in `Must not touch:`. Check each one:

- **Owns:** exact paths, or the exact question.
- **Must not touch:** everything else, and who owns the neighbouring pieces.
- **Depends on:** the members whose `READY` it must wait for, or `nothing`.
- **Seams:** any contract it shares with another piece. When two or more members share one, post it once, before anyone is started and before the individual briefs: a post whose first line addresses those members and the verifier and ends in BRIEF (`@parser @currency @verifier BRIEF`), then a `Seams:` block. The individual briefs then do not repeat it, and each still writes only its own member's name with `@`. The shared post goes first because a mention wakes a started member; `BOARD replace` copies it into a successor's brief.
- **Done when:** a check the member can run and see pass. "Works correctly" is not a check.
- **Repository rules:** the user's standing instructions that apply, such as commit-message rules. State the few rules that apply in the seam post. Do not send every member to read the project's guides (`AGENTS.md`, an architecture document): each member pays for the same files again.
- **How to report:** `BOARD ready <name>`, or the board tool's `ready` action for a specialist. A verifier reports with a post: the board refuses it `ready`.
- **Only what its tools can do.** An explorer, an investigator and an architect have no shell: they read and search. Do not tell one to run a command (`git diff`, a test, a script); the board refuses such a brief. Run the command yourself, write its output to a file outside the project, and name the file in the brief.

## Cost

- Honour the user's limits: record them with `BOARD limit` before registering anyone, and show `BOARD plan` before the team starts.
- Choose the cheapest agent type that can do the piece (`agent-types.md`).
- A member reads in full only the posts that mention it, and the latest `READY` of each member it depends on (a verifier: of every worker). Put what a member needs in its brief, or in a post that mentions it; do not expect it to have read the rest.
- A waiting member costs nothing. A member that polls or chats does. Briefs should make chatter unnecessary.
- A build or test suite that only one checkout can run at a time (a shared build folder, a machine-wide lock) makes parallel workers queue while each one's cache goes cold. Give each worktree its own build output where the tool allows it (`-derivedDataPath`, `CARGO_TARGET_DIR`); in a shared checkout, brief workers not to commit (one commit follows `VERIFY accept`; bare `git commit` is refused), to run only narrow fast checks for their piece (if even a filtered test triggers the whole build, skip it and name it in `READY` for the verifier), and never to invent a build lock or queue (an isolated agent is also refused a command built around `trap`).
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

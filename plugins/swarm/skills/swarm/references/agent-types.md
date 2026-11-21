# Choosing an agent type

You are the coordinator. For every piece of work decide two things: whether it needs a **member** or a **one-shot helper**, and which agent type.

## Member or one-shot helper

| | Member | One-shot helper |
| --- | --- | --- |
| What it is | Registered with `BOARD member`, briefed on the board, woken by mentions | A plain Agent call. Its answer returns to you and nowhere else |
| Use when | The piece takes more than one turn, others must ask it questions, or its result must be verified | You need one answer and nobody else will talk to the agent |
| Agent types | `swarm:*`, or `general-purpose` given the worker instructions | Any type the Agent tool lists |
| Afterwards | Its `READY` post is the record | Post a short summary yourself if members need the answer |

Explore and Plan cannot be resumed once they finish, so they cannot be woken. They are one-shot helpers only, never members.

## The swarm's own members

Each type runs on the newest model of its family. The table names families, not versions.

| Type | Model, effort | Can | Cannot | Give it |
| --- | --- | --- | --- | --- |
| `swarm:explorer` | Haiku, medium | Read, search; board tool | Run commands, edit, judge a design | "Where is it": symbols, call sites, entry points, tests. Also the analyst for one slice of large content, at low effort (`rlm.md`) |
| `swarm:investigator` | Opus, high. Fable, medium only as an escalation after an Opus investigator failed on the same question, through `BOARD replace <old> <new> model=fable effort=medium` | Read, search, LSP; board tool | Run commands, edit | "Why does it fail": subtle bugs, competing explanations, edge cases |
| `swarm:architect` | Fable, high. Medium for a consultation | Read, search, LSP; board tool | Run commands, edit | "How should it be built": new software from small tools to complex systems, design review, optimisation, migrations. Also your consultant: a second opinion on a complex decision during a run |
| `swarm:worker` | Sonnet, medium | Everything except spawning agents and loading skills | Spawn agents, load skills | Implementation inside assigned paths, tests, docs. Also combining other members' reports |
| `swarm:designer` | Opus, high | Everything except spawning agents, plus any connected design tools. Reads its Apple rules itself for a macOS, iOS or iPadOS target | Spawn agents, load skills; own production feature code | "How should it look and behave": screens and component specs, design tokens, icons and vector assets, app-icon artwork, art direction |
| `swarm:verifier` | Sonnet, medium. Opus, high when the change crosses several components, touches security, or includes design work: register `model=opus effort=high` and pass both on its Agent call | Read, run commands | Edit or write files, edit notebooks, spawn agents, load skills | The integrated candidate, once, with the exact checks. Also renders and measures design work: a designer's deliverables and UI built from its spec |

The three specialists have no shell. They read and post through the board tool, so register them with `profile=<type> writes=0` and launch them with the board-tool instructions from the `swarm` skill.

The designer is a profile but not a specialist. Register it with `profile=designer` and the paths it owns, and brief, spawn and wake it like a worker. It designs and a worker builds: give the designer the spec, tokens and assets, give the worker the production code, and make the worker depend on the designer.

## Built-in agents

These are always candidates for one-shot help. Check that the Agent tool lists a type before you plan around it; not every session has all of them.

| Type | Can | Use for |
| --- | --- | --- |
| `Explore` | Read and search, fast and cheap | A quick sweep before you split: which packages are involved, where the tests live |
| `Plan` | Read and search, at the conversation's model | A second opinion on your split or on an implementation approach, before any member is spawned |
| `general-purpose` | Everything | The stand-in when a `swarm:` type is unavailable: pass the model for the role and put the text of the matching agent file above the launch prompt. A stand-in loses the `disallowedTools` and the role-skill preload of its agent file (worker, designer and verifier each have both), and the hooks do not record it: run `BOARD member <name> id=<agent id> isolated=<0|1>` yourself after the Agent call |
| `Bash` | Shell only, where the session offers it | One command whose output you need, such as a failing-test list to group by package |
| `claude-code-guide` | Docs and web | A question about Claude Code itself |

## Agents from other plugins

Other installed plugins add types named `<plugin>:<agent>`. Use only the ones the Agent tool lists in this session, and read each one's description and tool list first: the name does not tell you what it can do.

| Kind | Typical examples, if installed | Fit in a swarm |
| --- | --- | --- |
| Review | `feature-dev:code-reviewer`, a security reviewer, a quality or lint enforcer | One-shot, on the candidate, before `VERIFY accept`. Post its findings to the worker that owns the code. It adds to the verifier and never replaces it |
| Research | `feature-dev:code-explorer`, an ADR or best-practice researcher | One-shot, before you split. Its result goes into the briefs |
| Design | `feature-dev:code-architect`, a refactoring architect | One-shot, or use `swarm:architect` when the design must be discussed on the board |
| Refactoring and implementation | a refactor implementer, a test writer, a simplifier | A member only if it has a shell and edit tools: register it as a worker and put the `swarm:worker` instructions above its prompt, since it does not know the board. Otherwise one-shot, in a worktree |
| SDLC | a CI pipeline designer, a compliance auditor | One-shot. Its output is a brief for a worker, or a finding for the report |

## Rules

1. **Tools must match the work.** A read-only type cannot implement. A type without a shell cannot run tests. Never brief an agent for work its tools cannot do: it will describe the change instead of making it.
2. **Cheapest type that can do it.** Locating is explorer work, not investigator work. Move a piece to a stronger type when a report shows the weaker one could not do it, not before.
3. **A specialist needs a distinct assignment.** Do not add an architect to a task that has no design question, or a designer to a task with no visual or interaction decision to make. A consultation is a distinct assignment: one stated question, one recommendation.
4. **One verifier per candidate.** More reviewers of the same diff are one-shot helpers, not more verifiers.
5. **Do not swap a member's model in place.** Replace the member (`team-management.md`).
6. **The user's choice wins.** If the user named a model, an effort or an agent type for a piece, use it and record it on the roster. A limit such as `opus=none` makes the board refuse an investigator on its default model: ask the user which model it may use, register it with that `model=`, and pass the same model on its Agent call.
7. **Limits cover helpers too.** The board and the plugin enforce limits only on `swarm:` members. A one-shot helper, or `general-purpose` standing in for a member, is yours to keep inside them: when a model is reserved or forbidden, pass an allowed `model` on that Agent call. `Plan` runs at this conversation's model, so do not use it under a limit that forbids that model.
8. **Each member type brings its own craft.** Each `swarm:` type's agent definition holds the rules it cannot work without, and its preloaded role skill holds the detailed method, so a brief states the piece and its limits and does not need to teach either. Native teammates start without the role skill: the definition carries the essentials and tells a designer or verifier which file to Read.

## Quick picks

| The piece | Type |
| --- | --- |
| Find every caller of a function | `swarm:explorer` |
| Explain an intermittent failure | `swarm:investigator` |
| Turn product requirements into an architecture and first-release plan | `swarm:architect` |
| Decide between two designs | `swarm:architect` |
| You, the coordinator, are unsure how to resolve a conflict between members or whether the split is sound | `swarm:architect`, briefed as a consultation |
| An Opus investigator could not settle the cause | Replace it with a Fable `swarm:investigator` |
| Design a settings screen for workers to build | `swarm:designer`, with the building worker `depends=` on it |
| Draw an icon set, an app icon, or a token set | `swarm:designer` |
| Check that built UI matches the designer's spec | `swarm:verifier` |
| Implement a handler and its tests | `swarm:worker` |
| Fix failing tests in one package of many | `swarm:worker` in a numbered pool |
| Run the suite on everything together | `swarm:verifier` |
| Analyse one slice of a 40,000-line log | `swarm:explorer` |
| Combine twelve slice reports | `swarm:worker`, registered `writes=0` |
| "Which directories does this touch?" before splitting | `Explore`, one-shot |
| Security pass over the finished candidate | An installed security reviewer, one-shot |

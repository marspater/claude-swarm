---
name: plan
description: "Preview the smallest Swarm team for a task before any run exists: the split, file ownership, dependencies, models, checks and a rough cost, or that one agent is enough. Starts no run. Usage: /swarm:plan <task>."
argument-hint: "<task>"
disable-model-invocation: true
model: opus
effort: medium
allowed-tools: Read, Grep, Glob, Bash(git ls-files *), Bash(git status *)
---

# Swarm plan

Preview a team for this task. Create nothing: no `init`, no `.swarm` folder, no member, no edit, no board command.

$ARGUMENTS

If no task is given above, ask for one and stop.

Read only what decides the split: the task, the file list (`git ls-files`, Glob), the repository's own instructions (CLAUDE.md, AGENTS.md, CONTRIBUTING), and the few files where pieces meet.

## Rules

- A piece is a set of paths or one question. Code and its tests are one piece.
- No path has two writers. A shared file goes to one member; the other depends on it.
- As few members as the task divides into, at most eight.
- A dependency only where the later piece cannot be written without the earlier result.
- Sequential work of one type and model is one worker's: a second worker pays a cold start of about 65,000 tokens and re-reads the files.
- Code or design changes get one verifier over the whole result.

Type defaults (model, effort): worker Sonnet, medium; verifier Sonnet, medium (Opus, medium when the change crosses components, touches security or includes design); explorer Haiku, medium; investigator Opus, high; architect Fable, high; designer Opus, high.

## Answer, briefly

1. The verdict first: a swarm, or "one agent is enough" with the reason, when the task is one file, one question, a change that fits in a sentence, or one problem whose parts must change together. For that verdict, stop after the reason.
2. A table of the smallest team: member, type, model and effort, what it owns (paths), what it waits for.
3. The checks the verifier would run, taken from the repository's instructions where they exist, and whether the run is shared (one checkout, owners that do not overlap) or isolated (a worktree per writer, when writers would break each other's build).
4. A rough cost, as an estimate from measured runs: about 0.4 to 1.1 million charged tokens per worker's piece, 0.3 to 1.3 million for a verifier, about 0.3 million for the coordinator in a fresh conversation, against the default budget of 3,000,000.
5. One line: start it with `/swarm:swarm` and the same task, in this conversation, so the plan is reused.

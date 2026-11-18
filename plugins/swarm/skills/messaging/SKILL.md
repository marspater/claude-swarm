---
name: messaging
description: "The message-board protocol of a swarm started with /swarm:swarm: how members address each other with @mentions, the kinds of post (BRIEF, READY, question, NOT PASSED, VERIFIED, SHUTDOWN) and what each must contain, how mentions are delivered and wake a waiting member, and what never to do. Load when writing or reading board posts as the coordinator, or when a member's posts are not reaching anyone."
user-invocable: false
---

# Messaging on the board

Everything a swarm says goes on one append-only board. There are no private messages between members. This keeps the whole conversation in one place, in order, where the user can watch it.

## Two ways to reach the board

| | Shell members: coordinator, worker, designer, verifier | Specialists: explorer, investigator, architect |
| --- | --- | --- |
| Read what is new: posts that mention you in full, the rest as one line each | `BOARD read <name>` | board tool, `action: "read"` |
| Post | `BOARD post <name>` with the text on stdin | `action: "post"`, `text` |
| Report done | `BOARD ready <name> [<commit>]` with the report on stdin | `action: "ready"`, `text` |
| Withdraw a report | `BOARD revise <name> [<reason>]` | `action: "revise"`, `text` |
| Read history without marking it read | `BOARD show [<name>]` | `action: "show"`, optional `member` |

From a shell, pass the text with a quoted heredoc so nothing in it is expanded:

```
BOARD post parser <<'EOF'
@currency what does formatAmount return for a negative zero?
EOF
```

## Addressing

- `@name` reaches one member. `@group` reaches a numbered pool. `@all` reaches everyone.
- A post reaches exactly the members it mentions. A post with no mention is a note on the record: nobody is woken for it.
- A member reads in full only what mentions it. Anything a member must know has to be in a post that mentions it.
- Recipients are fixed when the post is written. A member removed later stays in the history.
- A mention is `@` at the start of a word. An email address or a scoped package name is not a mention.
- Mention the member that can act. Mention the coordinator for a decision, a scope question, or a conflict between members, not for progress notes.
- `@all` wakes every member, working or waiting. Use it only for something every member must act on.
- When you name a member without needing it to act, write the name without `@`.

## Kinds of post

The first line says what the post is. Keep it to one line that makes sense alone: listings show only that line.

| First line | From | Must contain |
| --- | --- | --- |
| `@<name> BRIEF` | coordinator | Owns, must not touch, depends on, shared contracts, done when, repository rules, how to report |
| a question, with a mention | anyone | The exact thing you need, and the file and line it is about |
| `READY` (written by `ready`) | a member | What changed or was found, the files, the exact commands run and their result; for an isolated writer, the commit |
| `FINDING` (written by an investigator's `ready`) | an investigator | The same as a `READY`. It reaches only the coordinator, and releases nobody until `BOARD confirm` |
| `@<name> NOT PASSED` | verifier | File and line, the command, the decisive line of output; for design work the expected and the measured value; all of one member's problems in one post |
| `@coordinator VERIFIED <candidate> <commit or fingerprint>` | verifier | The exact line the candidate's test command returned, then the commands run and their results, and anything that could not be checked. The board refuses any other `VERIFIED` |
| `@coordinator NOT VERIFIED` | verifier | The candidate could not be tested or failed as a whole: the candidate, the command, the decisive output, and what would unblock it |
| `@<name> SHUTDOWN` | coordinator | The reason. The member answers with the state it left, then stops |

Use `ready` to report done. `ready` and `revise` are for workers, designers and specialists; the board refuses them from the coordinator and from a verifier, which report with a post. It records readiness and notifies the coordinator, the verifiers and the members that depend on you. An investigator's `ready` submits a finding to the coordinator. `BOARD confirm NAME SEQ` makes the exact reviewed finding ready and notifies dependents. Any change after a report needs `revise` first and a new `ready` after, because verification covers only what was reported.

## Writing a post

- **Point, do not paste.** Give paths and line numbers. Paste only the few lines that decide the matter, such as one failing assertion.
- **One post per recipient per topic.** Three problems for one worker are one post.
- **Say what you ran.** "Tests pass" is a claim; "`npm test -- date`: 14 passed" is evidence.
- **Separate what you traced from what you suspect.**
- **The board is not a progress log.** Post when someone needs to know or act.

## Delivery

The plugin watches the board. Workers, designers and verifiers get a nudge to read a batch of new mentions. The coordinator relays the corresponding nudge to a specialist through `SendMessage` so the specialist keeps its board tool. A waiting member resumes on delivery, and a working one sees the nudge at a tool boundary. Delivery is retried when it fails. When the board tool says more posts remain, keep reading until you have the whole batch. To see one historical post, use `show` with its `seq` in the board tool or `BOARD show --post=N` in Bash.

So:

- Answer a question by citing its number: `@asker re #12: …`. Attention then clears that question and leaves the asker's other open ones listed.
- To wait for an answer, post the question and end your turn. Do not sleep, poll, or re-read in a loop.
- Before ending any turn, read the board once more and handle the posts that mention you.
- The coordinator does not relay posts. If a member needs another member, it mentions that member.
- If the hooks are not running, the coordinator delivers by hand with `BOARD wake`, `claim` and `woke`, as the `swarm` skill describes.

## Never

- Message another member with SendMessage, or any channel but the board. The coordinator's wake nudge is the one exception, and it carries no content: the board's read command, or the board tool's `read` action.
- Answer for another member, or edit a file another member owns because it was slow to reply.
- Put secrets, tokens or personal data in a post. The board is a plain file in the project.
- Report `READY` or `VERIFIED` for something you did not run and see.

## When posts reach nobody

| Symptom | Check |
| --- | --- |
| `posted #N -> nobody` | The mention is misspelled, or the member is not on the roster. `BOARD status` lists the names |
| A member stays waiting with unread mentions | `BOARD wake`: an entry that stays means delivery is failing. See `swarm:team-management` |
| A post command printed `UNREAD: …` | Posts address you that you have not read. Read them before continuing. `BOARD close` refuses while the coordinator has any |
| Attention shows `ignored` | The member was woken three times and did not read. Run `BOARD retry <name>` so delivery tries again, or replace it |
| A member never saw an old post | A new member's unread posts start at its own brief. It reads earlier history with `show` |
| The run is paused | `BOARD resume` |

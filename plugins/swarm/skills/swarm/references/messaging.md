# Messaging on the board

You are the coordinator. This is the protocol you enforce and debug: what members are told to do on the board, and what to check when it goes wrong. Members learn their side of it from their own instructions, so nothing here goes into a brief.

Everything a swarm says goes on one append-only board. There are no private messages between members. This keeps the whole conversation in one place, in order, where the user can watch it.

## Two ways to reach the board

| | Shell members: coordinator, worker, designer, verifier | Specialists: explorer, investigator, architect |
| --- | --- | --- |
| Read what is new: posts that mention you in full, the rest as one line each | `BOARD read <name>` | board tool, `action: "read"` |
| Post | `BOARD post <name>` with the text on stdin | `action: "post"`, `text` |
| Report done | `BOARD ready <name> [<commit>\|HEAD]` with the report on stdin | `action: "ready"`, `text` |
| Withdraw a report | `BOARD revise <name> [<reason>]` | `action: "revise"`, `text` |
| Read history without marking it read | `BOARD show [<name> \| --post=N]` | `action: "show"`, optional `member` or `seq` |

`ready` and `revise` are a worker's reports, a designer's included. The board refuses them from a verifier, whose verdict is a post starting VERIFIED, NOT PASSED or NOT VERIFIED, and from you: you confirm a finding with `BOARD confirm <name> <seq>`.

From a shell, pass the text with a quoted heredoc so nothing in it is expanded:

```
BOARD post parser <<'EOF'
@currency what does formatAmount return for a negative zero?
EOF
```

## Addressing

- `@name` reaches one member. `@group` reaches a numbered pool. `@verifiers` reaches every verifier, `@dependents` every member whose `depends=` names the sender (nobody, for you). `@all` reaches everyone. No member or group can be named `all`, `verifiers` or `dependents`.
- A post reaches exactly the members it mentions. A post with no mention is a note on the record: nobody is woken for it.
- A member reads in full only what mentions it. Anything a member must know has to be in a post that mentions it.
- Recipients are fixed when the post is written. A member removed later stays in the history.
- A mention is `@` at the start of a word. An email address or a scoped package name is not a mention.
- A member mentions the member that can act. It mentions you for a decision, a scope question, or a conflict between members, not for progress notes.
- `@all` wakes every member, working or waiting. Use it only for something every member must act on.
- A name written without `@` wakes nobody. In a brief, put `@` only before the member the brief is for.

## Kinds of post

The first line says what the post is. Keep it to one line that makes sense alone: listings show only that line.

| First line | From | Must contain |
| --- | --- | --- |
| `@<name> BRIEF` | coordinator | Owns, must not touch, depends on, shared contracts, done when, repository rules, how to report |
| a question, with a mention | anyone | The exact thing you need, and the file and line it is about |
| `READY` (written by `ready`) | a member | What changed or was found, the files, the exact commands run and their result; for an isolated writer, the commit |
| `FINDING` (written by an investigator's `ready`) | an investigator | The same as a `READY`. It reaches only the coordinator, and releases nobody until `BOARD confirm` |
| `@<name> NOT PASSED` | verifier | File and line, the command, the decisive line of output; for design work the expected and the measured value; all of one member's problems in one post. It withdraws that member's `READY`, the members it is about fixed when it is posted: no candidate is prepared until the member reports again with `ready`. Answering a candidate since replaced (named on its first line, or the one the verifier tested last), it withdraws only a `READY` that candidate held, or a newer one the verifier has read when only the request it read last ties the verdict to the old candidate |
| `@coordinator VERIFIED <candidate> <commit or fingerprint>` | verifier | The exact line the candidate's test command returned, then the commands run and their results, and anything that could not be checked. The board refuses any other `VERIFIED` |
| `@coordinator NOT VERIFIED <candidate>` | verifier | The candidate could not be tested or failed as a whole: the candidate's id on the first line, the command, the decisive output, and what would unblock it. A verdict naming no candidate answers the one the verifier is testing and has given no verdict on, else the one the latest request it read names; a verdict on a replaced candidate leaves the test and pass of the one on the table alone |
| `@<name> SHUTDOWN` | coordinator | The reason. The member answers with the state it left, then stops |

`ready` reports a piece done. It and `revise` are for workers, designers and specialists; the board refuses them from you and from a verifier, which report with a post. It records readiness and notifies you and the members that depend on the sender; the verifiers are notified once the last worker is ready; the coordinator mentions a verifier when one piece needs it sooner. An investigator's `ready` submits a finding to the coordinator. `BOARD confirm NAME SEQ` makes the exact reviewed finding ready and notifies dependents. Any change after a report needs `revise` first and a new `ready` after, because verification covers only what was reported.

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
- A member that waits for an answer posts the question and ends its turn; it does not sleep, poll, or re-read in a loop. It reads the board again before ending a turn only when its last board command printed `UNREAD:`.
- You do not relay posts. If a member needs another member, it mentions that member; when one asks you to pass something on, tell it to mention the other.
- If the hooks are not running, you deliver by hand with `BOARD wake`, `claim` and `woke`, as the `swarm` skill describes.

## What no member may do

These hold for you too. When a member breaks one, say so on the board and have it corrected there.

- Message another member with SendMessage, or any channel but the board. Your wake nudge is the one exception, and it carries no content: the board's read command, or the board tool's `read` action.
- Answer for another member, or edit a file another member owns because it was slow to reply.
- Put secrets, tokens or personal data in a post. The board is a plain file in the project.
- Report `READY` or `VERIFIED` for something you did not run and see.

## When posts reach nobody

| Symptom | Check |
| --- | --- |
| `posted #N -> nobody` | The mention is misspelled, or the member is not on the roster. `BOARD status` lists the names |
| A member stays waiting with unread mentions | `BOARD wake`: an entry that stays means delivery is failing. See `team-management.md` |
| A post command printed `UNREAD: …` | Posts address the sender that it has not read. It reads them before continuing. `BOARD close` refuses while you have any |
| Attention shows `ignored` | The member was woken three times and did not read. Run `BOARD retry <name>` so delivery tries again, or replace it |
| A member never saw an old post | A new member's unread posts start at its own brief. It reads earlier history with `show` |
| The run is paused | `BOARD resume` |
| One member is paused (attention shows `member_paused`) | Its own token budget is spent and nobody wakes it. Ask the user, then `BOARD member <name> budget=<tokens>` and `BOARD resume <name>` |

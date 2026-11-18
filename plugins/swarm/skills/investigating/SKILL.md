---
name: investigating
description: "Only for swarm:investigator, which preloads it. Use for diagnosing failures. Covers tracing the failing path, disproving competing causes, distinguishing source evidence from runtime observations, and handing off a regression scenario."
user-invocable: false
---

# Investigating

Explain the cause of a specific failure. Give the next member enough evidence to fix it and enough context to test that the fix addresses the actual trigger.

## Method

1. **State the symptom precisely.** Record what happens, what should happen, and the known conditions. Attribute any observations shared in the brief and distinguish them from evidence you inspect yourself.
2. **Trace the real path.** Follow the entry point through dispatch, guards, state changes, and downstream effects. Use the language server when available and targeted text search otherwise. For an ordering issue, trace both paths and identify the ordering assumption.
3. **Compare the failing and working cases.** Find the smallest difference in input, state, or sequence that accounts for the behavior. Keep up to three plausible explanations in view and look first for evidence that would rule each one out.
4. **Check applicable edges.** Consider empty and boundary inputs, failure and retry, concurrency and cancellation, and older data along the traced path. Confirm that tests or later guards support the claimed outcome. If another investigator challenges the cause, respond with the evidence that would settle the disagreement.
5. **Decide what the evidence supports.** A source-traced finding needs a reachable trigger and a concrete consequence. If the outcome depends on configuration or timing you cannot observe, identify the narrow runtime observation that would distinguish the remaining explanations.

## Read along the path

- The board tool's `read` shows your brief in full and other posts as one line each. Read an explorer's map with `show` before you search for anything it already located.
- Read the functions on the failing path. Do not read modules the path does not touch.
- Stop when the brief's question is answered. If it requires a run, log, or measurement you cannot obtain through your tools, post the missing observation and mention the member who can collect it. Include the action they should perform and what result would confirm or rule out your explanation.

## Report

Use the board tool's `ready` action to submit a finding when the evidence meets the brief. The coordinator reviews the exact post before the board marks the investigation ready and releases its dependents. An explicitly requested shortlist of hypotheses can be complete if each uncertainty is identified. When the brief requires a cause and decisive evidence is still missing, post the blocker and leave the assignment pending. Aim for about 3000 characters.

- State the finding and the conditions that reach it.
- Cite `path:line` for the decisive steps. Give a line of evidence for each meaningful alternative you ruled out.
- Tell the owner where the fix belongs and which behavior it must preserve.
- Propose a regression check with setup, trigger, expected result, and the outcome expected on the current code.

> Source-traced. Two refresh attempts can start while the first promise is pending. `src/refresh.ts:44` checks the pending map and line 61 writes to it after awaiting the fetch. The scheduler can dispatch twice through `src/events.ts:18`. Install the pending entry before awaiting and clear it on completion. Test by holding the first fetch open, triggering a second refresh, and asserting a single fetch while both callers receive the result.

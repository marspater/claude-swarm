---
name: exploring
description: "Only for swarm:explorer, which preloads it. Use for scoped code search and file-slice analysis. Covers finding registrations and aliases, confirming paths with small reads, reporting exact references, and documenting search limits."
user-invocable: false
---

# Exploring

Find the smallest set of source locations that lets the next member start. A useful map identifies the entry point, the link to the implementation, and a test or fixture that establishes how the behavior is exercised.

## Search, then read a little

- The board tool's `read` shows your brief in full and other posts as one line each. You rarely need the others.
- Search the exact name or distinctive string. If hits are noisy, narrow by directory, language, or the name of the owning module. If hits are absent, try an imported alias, a route or event name, or the registration point. Treat generated code and fixtures as separate kinds of evidence.
- Read about thirty lines around a hit to confirm what it establishes. Open another range when an import, export, or registration is needed to resolve the symbol.
- Follow one hop from the definition to a caller, or from the caller to the definition. Extend the trace when a wrapper or dispatcher hides the connection the brief asks you to prove.
- Stop when the brief is answered. If it asks for **all** callers, state the search scope and how you accounted for aliases, re-exports, and indirect registration. Say which kinds of callers the search cannot resolve.

## What a good map contains

Group by what the reader needs, at most about fifteen references in all:

- **Entry points:** where the behaviour starts.
- **Definitions:** the function, type or config key itself.
- **Callers:** who uses it.
- **Tests:** which tests cover it, and how to run just those.
- **Open questions:** what a search cannot establish, such as dynamic dispatch, reflection, generated code, or values set at run time.

Use `path:line` and say what the line establishes. Identify the best starting point, then include only the supporting references somebody will use.

> Refresh requests enter through `src/api/refresh.ts:42`, which delegates to the handler registered in `src/jobs/registry.ts:21`. Start at `src/jobs/refresh.ts:67` for the retry branch. `tests/refresh.test.ts:88` exercises that branch. The deployed scheduler configuration is outside the searched repository.

## Analysing a slice

Read the assigned range and any header or imports expressly included in the brief. Put the slice's main finding on the first line. When the brief gives a taxonomy, bucket into its tags exactly and put what fits none under `OTHER`. When it gives a count boundary, read the overlap lines for context and leave them out of your totals. Report the count for each requested category, one representative line per pattern, and any changes or outliers. Note a truncated or overlapping boundary so the synthesizer can interpret counts across slices.

## Report

Use the board tool's `ready` action for a map or a completed scoped search. Keep it to about 2000 characters unless the brief specifies a different limit. If you are blocked by missing access or an unresolved prerequisite, name the gap and who can resolve it in a board post.

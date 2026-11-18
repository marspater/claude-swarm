---
name: rlm
description: "For the coordinator of a swarm started with /swarm:swarm, never for a swarm member. The RLM (Recursive Language Model) pattern: analyse a file, data export, log or directory that is too large for one context by partitioning the data, giving every analyst the same question over its own slice, and combining the reports. Load when a swarm task involves content over about 1500 lines that must be read in full, such as log analysis, a large CSV or JSON export, a long document, or a whole-codebase review."
user-invocable: false
---

# RLM: analysing content too large for one context

You are the coordinator. This is one shape of swarm: fan out over slices of the data, fan in to one report. BOARD and the roster commands are as the `swarm` skill defines them. The idea follows the Recursive Language Models paper (arXiv:2512.24601): the model never holds the whole input; it holds references to slices and the results of asking about them.

## The one rule

**Partition the data, not the question.** Every analyst gets the same question and a different slice. Members named after concerns ("error patterns", "root causes", "trends"), each reading the whole file, is the mistake this pattern exists to prevent: none of them can hold the file.

## When to use it

| Use RLM | Do not |
| --- | --- |
| One file over about 1500 lines or rows that must be read in full | It fits in one context: use one member |
| The answer needs every part: counts, distributions, trends, "is there anywhere that..." | A search answers it: one explorer with Grep |
| Several files that must be analysed together and are too large in total | The task is to edit the content, not analyse it |

## Procedure

### 1. Measure and type the content

Use `wc -l`, and read the first 50 lines. Unpack an archive first, into `<run>/extract/`. Decide the type by extension, and by content when the extension is `.txt`, `.log`, or says little:

| Signs | Type |
| --- | --- |
| A header row of delimited names | Table (CSV, TSV) |
| Lines of timestamp, level, message | Log |
| Starts with `[` or `{` and parses as one document | JSON |
| Every line is its own JSON object | JSON lines |
| Lines starting with `def`, `function`, `class`, `import`, `#include`, `package` | Source code |
| Headings and paragraphs | Prose |
| Anything else | Treat as prose |

Then write the **canonical taxonomy**: three to eight category tags, taken from the user's question and those first 50 lines (log levels, record kinds, error families, the things the user asked to count). Every analyst buckets into the same tags, so the synthesizer adds counts instead of guessing which labels mean the same thing. Keep the tags short and mutually exclusive, and always end the list with `OTHER`.

### 2. Partition

Slices are line ranges of the original file, passed by reference. You write no chunk files, with two exceptions noted below.

| Type | Slice size | Overlap | Where to cut | Tell each analyst |
| --- | --- | --- | --- | --- |
| Source code | 150 to 300 lines | none | Top-level boundaries: function, class, module, impl. With no boundaries, 200 lines with 20 overlap | To read the file's import block as well as its range |
| Table, under 20 columns | about 2000 rows | none | Even row counts | To read line 1, the header, as well as its range |
| Table, 20 columns or more | about 500 rows when dense, 1500 when sparse | none | Even row counts | The same |
| JSON lines | 500 to 1000 lines | none | Line counts | The field names of the first object |
| JSON, one document | 200 to 500 top-level elements | none | Top-level elements or keys | The field names and types of the first elements |
| Log | 200 to 5000 lines | 20 to 50 lines | Line counts; the overlap keeps a stack trace whole | "Slice M of N" |
| Prose | by `#` and `##` headings, else 250 lines | 25 lines without headings | Headings | "Slice M of N" |
| Config, markup, unknown | 200 lines | 20 lines | Line counts | "Slice M of N" |

The number of slices follows from the size. Do not pick a number of analysts and stretch the slices to fit.

Find the cut points with an indexer, not by reading. Reading the rest of the file to look for boundaries rebuilds it in your context, which is what the pattern avoids. A search that prints only line numbers and the matching lines gives you exact boundaries:

```
grep -nE '^(class |def |fn |impl |func |function |export |module )' <file>   # source code
grep -nE '^#{1,2} ' <file>                                                  # prose headings
```

Adjust the pattern to the language. If the index itself runs to hundreds of lines, cut it down (`| awk -F: '{print $1}'`, or only the top-level matches) and group consecutive units into slices of the size in the table.

Where slices overlap, each line still has one owner for counting. A slice's leading overlap belongs to the slice before it: the analyst reads those lines for context and leaves them out of its totals.

The exceptions: a JSON document on one line has no line ranges, so reformat it into `<run>/chunks/` first (`python3 -m json.tool`). And where rows are longer than a reader shows in full, as in a table with thousands of columns, an explorer cannot analyse them: cut the columns you need into `<run>/chunks/`, or use `swarm:worker` analysts, which have a shell.

### 3. State the cost before spawning

Tell the user the number of slices and that each is one Haiku agent. Above 16 slices, ask before you spawn. This replaces the `swarm` skill's ask-first rule for plans over five members: slice analysts are many, cheap and identical.

### 4. Register the team

- One analyst per slice: `BOARD member slice-01 profile=explorer writes=0 group=slice`, and so on. The type is `swarm:explorer`. Leave its model alone: slice analysis is counting and noticing, and a stronger model costs many times more for the same result.
- One synthesizer, of type `swarm:worker`, registered later: `BOARD member synth writes=0 depends=slice-01,slice-02,...` in the same step as its spawn (step 6). Registered now, it would be reported as unstarted for the whole run.
- No verifier. Nothing is being changed.

An analyst is used for one slice and never given a second. A fresh context per slice is the point.

### 5. Brief by reference

Never paste content into a brief. One brief per analyst, all with the same question, posted when that analyst is spawned (step 6):

```
@slice-03 BRIEF
Owns: /abs/path/app.log lines 9951-14950 (slice 3 of 12). Read nothing else in that file.
Count boundary: include only items that start at or after line 10001 in your totals. Lines 9951-10000
are overlap with the previous slice, read for context and stack-trace continuity only.
Question: <the user's question, word for word the same in every brief>
Taxonomy: bucket every finding into [<TAG_1>, <TAG_2>, <TAG_3>, OTHER]. If a major pattern fits none,
propose at most 2 new tags under OTHER.
Report: with the board tool's ready action. First line: one sentence with your slice's main finding.
Then, compactly:
- COUNTS: exact counts per taxonomy tag, respecting the count boundary
- CLUSTERS: recurring patterns, with one example line number each
- CROSS_REFS: IDs, symbols or trace keys that are cut off or point outside your slice
- OUTLIERS & GAPS: anomalies, spikes or changes over time, and what you could not determine
Give line numbers, not quotations. Keep it under 4000 characters.
```

The taxonomy line is word for word the same in every brief. Leave the count boundary line out for the first slice and for types partitioned without overlap.

The synthesizer's brief: wait for every slice; read the reports with `BOARD show <name>` for each analyst; produce overall rankings by frequency and impact, trends that cross slices, the risks likely to grow, and summary figures (items, range covered, slices); cite the post number behind every claim; mark any claim that rests on a single slice; list the slices that reported nothing or failed. Tell it to sum `COUNTS` per taxonomy tag, merge the tags analysts proposed under `OTHER` where they describe one pattern, and match each slice's `CROSS_REFS` against the neighbouring slices' reports.

The synthesizer reads reports only, with one exception that you write into its brief together with the file path: it may inspect up to 3 narrow line ranges of the source, at most 40 lines each, solely to resolve conflicting counts across an overlap or to verify a critical claim that rests on a single slice. It reports each range it read and what the range settled. This is cheaper than a new member for 30 lines; anything larger is still a closer look by a new member (see Recursion).

### 6. Spawn in stages

Spawn at most eight analysts at a time, and post a slice's brief in the same step as its spawn, never earlier: a briefed member with no agent shows up as owed a wake. As `READY` posts arrive, brief and spawn the next slices.

Between batches, let the earlier slices inform the later ones. When the one-line headers of two or more finished analysts name the same new tag or the same critical ID (a correlation ID, an error code, a symbol), add one line to the briefs of the slices not yet spawned: `Watchlist from earlier slices: also track occurrences of [<tag or id>].` Take it from the headers only, keep it to that one line, and do not open the full reports for it. Briefs already posted stay as they are. Register, brief and spawn the synthesizer after the last batch has started, so it does not sit idle through the run.

### 7. Keep your own context small

Read the board with `BOARD read coordinator --headers`. Each report then costs you one line. Do not read the analysts' full reports: that rebuilds the file in your context, which is what the pattern avoids. Read in full only the synthesizer's report: `BOARD show synth`.

### 8. Report

Give the user the synthesis, the slice count, and the gaps the synthesizer listed. Then `BOARD close`.

## Recursion

- **A slice is still too much.** If an analyst reports that it could not get through its slice, register two new analysts for the two halves. Do not send the same analyst back.
- **Too many reports for one synthesizer.** Above about twelve reports, add a level: one synthesizer per group of up to twelve analysts, and a final synthesizer that depends on those.
- **A finding needs a closer look.** If it is beyond the synthesizer's spot-check budget, brief a new member on that narrow range and question, by reference. A second pass over a small range is cheap; a second pass over everything is not.

## Several files

1. List the files, skipping `node_modules`, `.git`, build output, binaries and lock files. Above 20 files, ask the user which matter.
2. Size each one: small is up to 1500 lines, medium up to 5000, large beyond.
3. Small files of one type are batched: one analyst reads several files, up to about 1500 lines in total. Medium and large files are partitioned as above.
4. If the number of analysts equals the number of files and some files are large, you have not partitioned.
5. With mixed types, synthesize in two phases: one synthesizer per type, and a final one that depends on them and looks for what crosses types.

## Failures

| What happened | Do |
| --- | --- |
| An analyst stopped without a `READY` | Replace it with a new member for the same slice (the `swarm` skill's `team-management.md` reference). Leave the others alone |
| A report is a paste of the content | Ask that analyst for counts and line numbers instead, once. If it repeats, replace it |
| The synthesizer is waiting on a slice that will never come | Either replace the analyst, or drop the dependency and tell the synthesizer to list the slice as missing |
| Reports disagree across an overlap | The count boundary should prevent double counts, so check that both briefs carried one. The synthesizer resolves what is left with its spot-check budget; brief a closer look only if it still changes the answer |

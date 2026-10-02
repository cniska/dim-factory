---
name: dim-artifact
description: How every factory artifact is written for the owner — the outcome first, drawn from the record. Use from dim-plan, dim-build and dim-review when writing the plan, the Build artifact or the Review artifact.
---

# Artifact

An artifact is the owner's reading of a station's work. They read it instead of the diff, the queries and the worker's session, so it is Markdown that stands on its own.

- Open with the outcome: what is true for the owner now and what they must decide. The reasons and the evidence follow.
- Write what the record supports and name what it does not. A claim carries its evidence, such as a commit, a check's result, a query's answer or a file and line, or is labeled unverified. No check passed because a process exited.
- Separate fact from judgement. Label an assumption, a deviation from the plan or an open risk rather than smoothing it over.
- Size it to the change. One or two sentences under a heading is enough for a narrow change; a cross-boundary change carries the contracts and decisions the owner must check. Each section the station names is one `##` heading, and an empty section is omitted. Comparable rows, such as slices or areas, go in a table.
- Repeat nothing: not a fact in two sections, not the log's command output, not a file inventory or a slice-by-slice diary.
- Keep commands, paths and identifiers exact where they let the owner verify a claim.

A returned artifact comes back revised by the same worker, addressing the stated reason. The record keeps the earlier revision.

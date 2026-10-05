---
name: dim-plan
description: Plan a factory order — find what was already built and decided, name the data shape, and cut slices that each verify on their own. Use as the planner, when a brief names dim-plan.
---

# Plan

The brief carries the `order` (its id, title, project and description), the `workspace` to read, `returned` (why the order is back at plan, when it is) and `committed` (the commits already on the order's branch).
## Returns

Write the plan as JSON, `{"body": "<the plan>", "slices": [{"title": "…", "outcome": "…"}]}`, to a file under `$TMPDIR` and run `dim plan return <file>`. A reply naming what is missing records nothing: fix the plan and return it again. A second miss fails the station.

When the order cannot be planned as written, run `dim order return --reason "<what the operator must decide>"`. The order goes back to the operator, who updates it and runs it again.

`dim order show` prints the order and its log. `dim message send <text>` leaves the operator a note it reads after the turn.

## Read before designing

1. Has this shape been built here before? `dim query prior-art "<path fragment>"` ranks the most recently touched tracked files whose path matches, in each repo on disk. Read the repo column before the file, then read the file: recency and commit count say where to look, never whether it was got right.
2. Was this already decided? `dim query search "<words the decision would use>"` finds where it was said, and `dim query thread <session>@<when>` reads the exchange a hit sits in. A decision already taken is not yours to re-take; find it and say what it settled.
3. What does the project hold? Its rules, the code the change touches and the docs that own it, in the project's own words.

For a defect, [bug](references/bug.md) under Plan.

An empty record is a fact about the work being new, and the plan says so.

## Design

Name the data shape before any logic: the types, states and transitions the change adds or moves, and what owns each. Logic designed before its shape is settled is redesigned when the shape is.

Prefer the project's names and existing contracts. A new concept gets one owner and one word.

Settle every choice that is yours and state it: which of two shapes, what to name it, the order of the slices. The owner's choices are the hard-to-reverse and the outward-facing; the plan names them under decisions rather than making them.

## Slices

A slice changes behavior and is verified by the project's check on its own. A slice that only makes sense once a later slice lands is not a slice. Its `outcome` is what is true once it is committed, in terms the owner can check.

The builder commits the slices in order, one commit each. On a revision with `committed` commits, say which of them stay, change or go, and list only the slices still to build.

## Check the plan

Hand the plan and what the queries returned to one agent with read-only tools and a fixed brief, without the reasoning that got there. Its questions:

- is every slice verifiable on its own
- does the change imply an input or failure mode that no slice's outcome exercises
- does the plan add a function, file, column or term the outcome does not need, or give an existing name a second meaning
- does it ask the owner a question the record or an experiment could answer
- does the change touch a rule the project's docs state, such as a module boundary or a glossary word, that the plan does not name

Returning nothing is the expected result.

## The body

`body` follows [artifact](references/artifact.md): no title, the outcome first, drawn from the record. Its sections, in this order:

1. **Outcome**: two or three sentences on what is true once the order ships, and its boundary.
2. **Decisions**: what the owner must approve before the build, such as a schema, contract, spec or gate change, a project rule the plan bends, or a slice that cannot start from a failing test. Always present; "None." when there are none.
3. **Cause**: for a defect, with the evidence and what it ruled out.
4. **Slices**: a table of title, a one-line outcome and the test that fails before the slice. The JSON `outcome` is that same line.
5. **Risks**, and what review should aim at.
6. **For the builder**: the data shape, contracts and paths the build needs, last and terse.

A section the change does not earn is omitted, except Decisions.

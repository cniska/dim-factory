---
name: dim-plan
description: Plan a factory order against what this machine already did — prior art on disk and decisions already taken — and return the plan the owner approves and the builder builds. Use as the planner, when a brief names dim-plan.
argument-hint: "<what you are about to build>"
---

# Plan

A plan written without reading the record re-derives what is already on disk. This machine holds every session it has run, every commit those sessions led to, and every file each commit touched. So the questions below are queries rather than guesses, and each one can delete a branch of the plan before it is written.

This is what separates a station from a checklist: the checklist is the same everywhere, and these answers are about this machine.

The brief carries only what this skill cannot know: the `order` (its title, project and description), the `workspace` to read, `returned` (why the order came back, on a revision) and `committed` (commits already on the order's branch). When the order describes a defect, find its cause before planning its fix: reproduce it and name the code that produces it.

The turn ends in one of two returns. Write the plan as JSON, `{"body": "<the plan>", "slices": [{"title": "…", "outcome": "…"}]}`, to a file under `$TMPDIR`, then run `dim plan return <file>`; each slice's `outcome` is what verifies it. A reply naming what is missing records nothing, so fix the plan and return it again. When the order cannot be planned as written, run `dim order return --reason "<what the operator must decide>"` instead.

## Entry contract

Answer each before proposing an approach.

1. **Has this shape been built here before?** `dim query prior-art "<path fragment>"` names every tracked file whose path matches, across the repos on disk, dated by the commits that touched it. Every path it prints opens, so the answer is a file to read rather than a memory. Read the repo column before the file — a repo that was only cloned ranks beside the owner's own — and treat recency and commit count as where to look, never as quality.

2. **Was this already decided?** `dim query search "<words the decision would use>"` matches them over every message anyone said, and each hit names the exchange `dim query thread` reads. A decision already taken is not yours to re-take; find it and say what it settled. Where it comes back empty and only a file sweep will answer, the planner sweeps for itself: it reads the repo under the same fixed question, and a separate hand to search would return a conclusion whose grounds the planner then could not check.
## Design the change

The answers are evidence, not the design. Read the project's rules, affected code and owning docs. Define the requested outcome, boundary, invariants and independently verifiable slices from that context and the record's returned facts. Prefer the project's names and existing contracts; give a new concept one owner and one word.

Ask the owner only when the choice is genuinely theirs, which is narrower than it feels. It is theirs when the work is hard to reverse, when it is outward-facing, or when it spends something that lands on every session rather than this one. Everything else — which of two shapes, what to name it, what order to slice it in — is settled here and stated, not asked. A question that a query could have answered is a question that should have been a query.

## Check the plan before acting on it

A plan is cheaper to fix than the code written from it, so it gets the same treatment a slice gets in `dim-build`: one agent working from a fixed brief, and not the agent that wrote the plan. Give it the plan and what the queries returned — not the reasoning that got there, or what comes back is agreement.

The brief is these questions:

- is every slice a cut that can be verified on its own, or does one of them only make sense once a later slice lands
- does each slice name the repo's own task as its check, rather than a command assembled by hand
- does the change imply an input or failure mode that no slice's test exercises
- does the plan say what the record returned and what that removed, or does it read as though nothing was looked up
- does anything here ask the owner a question one of the queries could have answered
- does the design add a function, wrapper, file, column or term the outcome does not need, or give an existing name a second meaning; name the smaller design without it
- does the plan set aside a defect of the same shape as the one it fixes, when fixing it is in reach of this order

Returning nothing is the expected result. A reviewer earns trust the way a test does — plant a defect once, watch it be caught, take it out.

## Write for the owner

Use `dim-artifact` for the shared artifact-writing contract. This station supplies the plan's design dimensions:

The plan is the shared artifact the owner approves and the builder executes, not a private implementation prompt. Make the first page answer what the owner needs to decide while making the rest precise enough for the builder to follow:

- **Outcome.** What becomes true, the boundary of the change, explicit non-goals, and the decisions that belong to the owner.
- **Evidence.** Prior art, settled decisions, project conventions, unresolved gaps, and what each finding ruled out.
- **Contracts.** Inputs, outputs, invariants, states, transitions, errors, closed vocabularies, and ownership of each boundary.
- **Program design.** The bounded file tree, key signatures, call path, data flow, and boundary crossings.
- **Checks.** An executable check for each contract and the repository's own task for every slice.
- **Slices.** The behavior, affected area, check, and dependency for each independently verifiable vertical cut. The builder's nth commit is the nth slice, so on a revision with commits already on the branch, say which of them stay, change or go, and count the new slices from the branch as it stands.
- **Risks and decisions.** Holds, unresolved questions, predictions, and the conditions under which the operator should approve the plan.
- **Review scope.** What the review should aim at: the concrete questions each area must answer for this change, and whether it touches a performance-sensitive path, the one area review runs only when the plan names one. It never removes an area; every other pass `dim-review` lists runs on every order.

Use readable Markdown and project language. Keep identifiers, commands, and paths where they let the owner verify a claim; do not make the owner reconstruct the design from a worker transcript.

Scale the explanation to the change. Lead with a concise decision summary, then include the supporting detail justified by the change's size and risk. A small fix can stay short; a multi-boundary change needs the full program design. Scaling the prose never removes a required contract dimension.

The plan is this station's human-facing artifact. Return the dimensions this change needs, with its evidence and ordered slices, as the `body`; the next station does not start until the owner has approved that exact revision.

## Exit check

The plan is done when it names the outcome and the dimensions this change needs for approval and execution. It does not repeat dimensions that add no decision or implementation value.

If every query came back empty, say that in the plan. An empty record is a fact about the work being new, and it is worth more written down than silently skipped.

## See also

- `dim-artifact`

## What the record cannot tell you

The record is process: what was said, run, loaded and stopped. It cannot say whether any of it was right. `dim query prior-art` cannot tell a file that was got right from one that was abandoned, and a file copied between repos looks as settled as one that was worked out. Use it to find the reading, and do the reading.

## Red flags

- designing from memory after a query could answer the question
- asking the owner to decide an ordinary implementation choice
- writing a plan the builder cannot execute or the owner cannot approve
- adding detail that does not reduce a decision or implementation risk

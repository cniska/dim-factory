---
name: dim-station-review
description: Review a diff dimension by dimension, one agent each, aimed by what this machine's record says about the ground the change stands on. Use before merging a change or handing it to someone else.
argument-hint: "<diff, branch or path>"
---

# Review

One pass per dimension, each in its own agent. A single reader carrying every dimension's checklist applies whichever it read last, and the dimensions are cheap to run in parallel because none of them needs the others' findings.

What makes this a station rather than a checklist is that the record says where to aim. This machine knows which kinds of work have been drawing later `fix:` commits and which code shipped with nothing coming back, so a dimension arrives knowing what it is reading against instead of sweeping.

Use `dim-git` for the read-only diff boundary and handoff evidence. Review does not edit, commit or land the work it inspects.

This station carries its review briefs directly. Each dimension supplies findings; this station supplies the factory grounding, read-only boundary and finding convergence.

The reviewer returns a structured report, and the factory records its findings and rulings under the reviewer identity and renders the owner's Review artifact from it ([`src/review-report.ts`](../../src/review-report.ts)): the verdict, blocking findings, owner rulings, earlier findings, plan conformance, coverage, what was not judged, and observations. The report carries no praise, no walkthrough of the diff and no account of how the review ran.

Use `dim-artifact` for the shared artifact-writing contract. This station supplies the verdict sentence and every section the factory renders.

The report is one JSON object, defined in [`src/review-artifact.schema.json`](../../src/review-artifact.schema.json) and parsed in [`src/review-artifact.ts`](../../src/review-artifact.ts):

- `verdict` — one sentence saying why the order may advance or must return.
- `findings` — each `{dimension, file, line, failure, fix, severity}`. Every finding blocks, at `critical`, `high` or `medium`; a point that would not block goes in `observations`.
- `rulings` — from round two on, one `{finding, ruling, reason}` for every open earlier finding the brief lists and none otherwise. A finding answered `fixed`, or a refusal the owner overturned, takes `addressed` or `not_addressed`; a refusal that still stands takes `refusal_accepted` or `refusal_contested`. `not_addressed` and `refusal_contested` give the reason.
- `conformance` — each `{kind, slice, detail}`, where `kind` is `missing`, `extra` or `misunderstood`, judged against the approved plan. A deviation that must be fixed is also a finding in the `plan` dimension.
- `coverage` — exactly one `{dimension, status, reason}` per dimension below: `findings` exactly when a finding carries that dimension, `clean` exactly when none does, or `not_applicable` or `not_run` with the reason.
- `set_aside` — each `{item, why}` left out as outside the order.
- `unverified` — each `{claim, would_settle}` that could not be checked.
- `observations` — at most three strings, none of which blocks.

Every property is present, and one with nothing to say is `null` or `[]`. Stop for the operator's gate after returning the report. If the owner returns the artifact, return the same structure with empty `findings` and `rulings`, addressing only the feedback; the factory renders it again from what the round recorded. A closed review is not accepted until the operator approves it with `dim order approve <order-id>`.

## Entry contract

Before spawning anything:

1. **Size the diff**, and split it when it combines unrelated work or is too large to review as one logical change. A review that cannot hold the change is not evidence that the change is sound.
2. **Read the tests first**, then get the intent behind the diff. Tests reveal the behavior the change claims and the failure paths the author considered; the intent explains what the tests cannot.
3. `dim q fixes` — how often files edited under each skill drew a later fix commit. It counts by skill and names no path, so it says which kind of work has been coming back, never which file in this diff did.
4. `dim q exemplars` — code that shipped with no fix coming back. These are candidates, not verdicts: a file nobody returned to may have been right or may have been abandoned.

## The passes

Spawn one agent per dimension at the tier `dim route <harness> reviewer` gives you for the harness you run in, each given the diff, the intent, and only the grounding below, and each with read-only tools. Withhold your own read of the diff — hand over a conclusion and what comes back is agreement with it. A reviewer that can edit answers a finding by editing, and what it overwrites is work it was sent to read ([`build-order.md`](../../docs/build-order.md)).

| dimension | what the record gives it |
|---|---|
| plan | whether the diff delivers the approved plan's slices, naming work that is missing, extra or misunderstood; read the plan in the brief |
| correctness | whether the changed code fulfills its stated behavior, handles failure paths and preserves existing contracts; use `dim q exemplars` as grounding |
| tests | whether meaningful behavior is covered by tests that fail when the invariant is removed; use `dim q rework` as grounding |
| architecture | whether responsibilities, boundaries, dependencies and extension points remain coherent; use `dim q prior-art "<path fragment>"` as grounding |
| maintainability | whether the change leaves the next worker with readable, simple, cohesive code: clear names, direct control flow, earned abstractions, one vocabulary per domain concept, and no unnecessary indirection; use the glossary, project rules and nearby patterns |
| docs | whether long-lived docs describe the resulting behavior and terminology; use `dim q stale <id-prefix>` as grounding |
| security | whether the diff creates a concrete trust-boundary, data-exposure or unsafe-default path; read the diff and project rules |
| performance | whether the change introduces a material cost in latency, memory, I/O or unbounded work; run only when the plan identifies a performance-sensitive path |
| style | whether naming, structure and local patterns remain consistent without adding comments or abstraction noise; read the diff and project rules |

The performance pass is conditional: a plan that does not identify a performance-sensitive path does not spawn it. Maintainability remains a normal pass because every slice leaves code for the next worker. Both passes need concrete evidence; a preference or hypothetical cost is not a finding.

## Exit check

The review is done when:

- every dimension has one coverage entry, including the ones that found nothing, and a dimension whose agent failed to return is `not_run` with that reason rather than quietly dropped
- each finding names a file the diff changed and a line that file has at the head commit, what fails, the fix direction and a blocking severity — a finding with no failure case is an opinion, and the factory refuses the report
- every open earlier finding the brief lists has exactly one ruling, and a contested refusal says why the refusal does not hold
- no more than three observations, none of which blocks
- findings that contradict each other are resolved here, not passed on as a list
- every finding a dimension raised was checked at its source before it was passed on, cited to `file:line`
- a path the record named as having held is read against that, and a finding against it is either addressed or explicitly cleared

A dimension's finding is a claim, and a claim carried forward unchecked is how a wrong one becomes the standard. Checking it is this station's work whether or not the reviewer wrote the code — where the author is in the session, `dim-station-build` says what answering one looks like.

## See also

- `dim-artifact`

## What the record cannot tell you

Every query here is process or history, never a verdict on this diff. `fixes` says how often work under a skill drew a later fix commit, which is the repo's own judgement on earlier changes, not on this one. Read all of it as where to look hardest, and let the reading decide.

## Red flags

- reporting a finding without a concrete failure path
- reviewing only the implementation and not the tests or intent
- spawning a conditional dimension without a question it can answer
- accepting a clean process exit as a clean review

---
name: dim-station-review
description: Review a diff dimension by dimension, one agent each, aimed by what this machine's record says about the ground the change stands on. Use before merging a change or handing it to someone else.
argument-hint: "<diff, branch or path>"
---

# Review

One pass per dimension, each in its own agent. A single reader carrying six checklists applies whichever it read last, and the dimensions are cheap to run in parallel because none of them needs the others' findings.

What makes this a station rather than a checklist is that the record says where to aim. This machine knows which kinds of work have been drawing later `fix:` commits and which code shipped with nothing coming back, so a dimension arrives knowing what it is reading against instead of sweeping.

Use `dim-git` for the read-only diff boundary and handoff evidence. Review does not edit, commit or land the work it inspects.

This station carries its review briefs directly. Each dimension supplies findings; this station supplies the factory grounding, read-only boundary and finding convergence.

The review is an artifact for the owner as well as evidence for the operator. Lead with the verdict and why it matters, then include detail proportional to the change's size and risk. Keep every finding's contract, evidence, file and worker attribution even when the prose stays short.

Return one Review artifact with the verdict, dimensions covered, evidence considered, and the reason the order may advance or must return. Keep each finding separately attributed beneath it. Stop for the operator's gate after submitting the artifact; a closed review is not an accepted review until the operator approves that exact revision.

## Entry contract

Before spawning anything:

1. **Size the diff**, and split it when it combines unrelated work or is too large to review as one logical change. A review that cannot hold the change is not evidence that the change is sound.
2. **Read the tests first**, then get the intent behind the diff. Tests reveal the behavior the change claims and the failure paths the author considered; the intent explains what the tests cannot.
3. `dim q fixes` — how often files edited under each skill drew a later fix commit. It counts by skill and names no path, so it says which kind of work has been coming back, never which file in this diff did.
4. `dim q exemplars` — code that shipped with no fix coming back. These are candidates, not verdicts: a file nobody returned to may have been right or may have been abandoned.

## The passes

Spawn one agent per dimension at the tier `dim route codex reviewer` gives you, each given the diff, the intent, and only the grounding below, and each with read-only tools. Withhold your own read of the diff — hand over a conclusion and what comes back is agreement with it. A reviewer that can edit answers a finding by editing, and what it overwrites is work it was sent to read ([`build-order.md`](../../docs/build-order.md)).

| dimension | what the record gives it |
|---|---|
| correctness | whether the changed code fulfills its stated behavior, handles failure paths and preserves existing contracts; use `dim q exemplars` as grounding |
| tests | whether meaningful behavior is covered by tests that fail when the invariant is removed; use `dim q rework` as grounding |
| architecture | whether responsibilities, boundaries, dependencies and extension points remain coherent; use `dim q prior-art "<path fragment>"` as grounding |
| maintainability | whether the change leaves the next worker with readable, simple, cohesive code: clear names, direct control flow, earned abstractions and no unnecessary indirection; use the project rules and nearby patterns |
| docs | whether long-lived docs describe the resulting behavior and terminology; use `dim q stale <id-prefix>` as grounding |
| security | whether the diff creates a concrete trust-boundary, data-exposure or unsafe-default path; read the diff and project rules |
| performance | whether the change introduces a material cost in latency, memory, I/O or unbounded work; run only when the plan identifies a performance-sensitive path |
| style | whether naming, structure and local patterns remain consistent without adding comments or abstraction noise; read the diff and project rules |

The performance pass is conditional: a plan that does not identify a performance-sensitive path does not spawn it. Maintainability remains a normal pass because every slice leaves code for the next worker. Both passes need concrete evidence; a preference or hypothetical cost is not a finding.

## Exit check

The review is done when:

- every applicable dimension reported, including the ones that found nothing, and a dimension whose agent failed to return says so rather than being quietly dropped
- each finding names a file and line, and what fails — a finding with no failure case is an opinion
- findings that contradict each other are resolved here, not passed on as a list
- every finding a dimension raised was checked at its source before it was passed on, cited to `file:line`
- a path the record named as having held is read against that, and a finding against it is either addressed or explicitly cleared

A dimension's finding is a claim, and a claim carried forward unchecked is how a wrong one becomes the standard. Checking it is this station's work whether or not the reviewer wrote the code — where the author is in the session, `dim-station-build` says what answering one looks like.

## What the record cannot tell you

Every query here is process or history, never a verdict on this diff. `fixes` says how often work under a skill drew a later fix commit, which is the repo's own judgement on earlier changes, not on this one. Read all of it as where to look hardest, and let the reading decide.

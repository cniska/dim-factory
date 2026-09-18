---
name: dim-review
description: Review a diff dimension by dimension, one agent each, aimed by what this machine's record says about the ground the change stands on. Use before merging a change or handing it to someone else.
argument-hint: "<diff, branch or path>"
---

# Review

One pass per dimension, each in its own agent. A single reader carrying six checklists applies whichever it read last, and the dimensions are cheap to run in parallel because none of them needs the others' findings.

What makes this a station rather than a checklist is that the record says where to aim. This machine knows which kinds of work have been drawing later `fix:` commits and which code shipped with nothing coming back, so a dimension arrives knowing what it is reading against instead of sweeping.

## Entry contract

Before spawning anything:

1. **Get the diff**, and the intent behind it. A review of a diff whose purpose is unstated grades style, because that is all that is left to grade.
2. `dim q fixes` — how often files edited under each skill drew a later fix commit. It counts by skill and names no path, so it says which kind of work has been coming back, never which file in this diff did.
3. `dim q exemplars` — code that shipped with no fix coming back. These are candidates, not verdicts: a file nobody returned to may have been right or may have been abandoned.

## The passes

Spawn one agent per dimension, each given the diff, the intent, and only the grounding below, and each with read-only tools. Withhold your own read of the diff — hand over a conclusion and what comes back is agreement with it. A reviewer that can edit answers a finding by editing, and what it overwrites is work it was sent to read ([`build-order.md`](../../docs/build-order.md)).

| dimension | what the record gives it |
|---|---|
| correctness | whether `exemplars` names a path in this diff — code that has held, so a change to it is read against that |
| tests | `dim q rework`, where work was revisited after a pushback |
| architecture | `dim q prior-art "<path fragment>"` — how this shape is built in the repos on disk; apply the [architecture-review brief](../../../../.agents/skills/architecture-review/SKILL.md) where it is available |
| docs | `dim q stale <id-prefix>` — whether the code a doc describes has moved since |
| security | nothing; read from the diff alone |
| style | nothing; read from the diff alone |

The last two rows are not an oversight. The record holds no signal about either, and inventing one would be worse than the gap — an agent told it has grounding it does not have stops looking.

## Exit check

The review is done when:

- every dimension reported, including the ones that found nothing, and a dimension whose agent failed to return says so rather than being quietly dropped
- each finding names a file and line, and what fails — a finding with no failure case is an opinion
- findings that contradict each other are resolved here, not passed on as a list
- every finding a dimension raised was checked at its source before it was passed on, cited to `file:line`
- a path the record named as having held is read against that, and a finding against it is either addressed or explicitly cleared

A dimension's finding is a claim, and a claim carried forward unchecked is how a wrong one becomes the standard. Checking it is this station's work whether or not the reviewer wrote the code — where the author is in the session, [`dim-build`](../dim-build/SKILL.md) says what answering one looks like.

## What the record cannot say

Every query here is process or history, never a verdict on this diff. `fixes` says how often work under a skill drew a later fix commit, which is the repo's own judgement on earlier changes, not on this one. Read all of it as where to look hardest, and let the reading decide.

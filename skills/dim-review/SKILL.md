---
name: dim-review
description: Review a diff dimension by dimension, one agent each, aimed at the files this machine's record says have broken before. Use before merging a change or handing it to someone else.
argument-hint: "<diff, branch or path>"
---

# Review

One pass per dimension, each in its own agent. A single reader carrying six checklists applies whichever it read last, and the dimensions are cheap to run in parallel because none of them needs the others' findings.

What makes this a station rather than a checklist is that the record says where to aim. This machine knows which files an agent edited that a later `fix:` commit had to come back to, and which shipped with nothing coming back, so a dimension arrives pointed at something instead of sweeping.

## Entry contract

Before spawning anything:

1. **Get the diff**, and the intent behind it. A review of a diff whose purpose is unstated grades style, because that is all that is left to grade.
2. `dim q fixes` — files an agent edited that a later fix commit came back to, grouped by the skill that was loaded. Any path in this diff that appears there has broken before; name it in that agent's brief.
3. `dim q exemplars` — code that shipped with no fix coming back. These are candidates, not verdicts: a file nobody returned to may have been right or may have been abandoned.

## The passes

Spawn one agent per dimension, each given the diff, the intent, and only the grounding below. Withhold your own read of the diff — hand over a conclusion and what comes back is agreement with it.

| dimension | what the record gives it |
|---|---|
| correctness | the `fixes` rows for paths in this diff — what broke here before |
| tests | `dim q rework`, where work was revisited after a pushback |
| architecture | `dim q prior-art "<path fragment>"` — how this shape is built in the repos on disk |
| docs | `dim q stale <id-prefix>` — whether the code a doc describes has moved since |
| security | nothing; read from the diff alone |
| style | nothing; read from the diff alone |

The last two rows are not an oversight. The record holds no signal about either, and inventing one would be worse than the gap — an agent told it has grounding it does not have stops looking.

## Exit check

The review is done when:

- every dimension reported, including the ones that found nothing, and a dimension whose agent failed to return says so rather than being quietly dropped
- each finding names a file and line, and what fails — a finding with no failure case is an opinion
- findings that contradict each other are resolved here, not passed on as a list
- anything the record flagged as having broken before is either addressed or explicitly cleared

## What the record cannot say

Every query here is process or history, never a verdict on this diff. `fixes` says a file drew a later fix commit, which is the repo's own judgement on some earlier change to it, not on this one. Read all of it as where to look hardest, and let the reading decide.

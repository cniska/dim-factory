---
name: dim-review
description: Review a diff area by area, one agent each, and return either findings or the Review artifact. Use as the reviewer, when a brief names dim-review, or before merging a change or handing it to someone else.
argument-hint: "<diff, branch or path>"
---

# Review

One pass per area, each in its own agent. A single reader carrying every area's checklist applies whichever it read last, and the areas are cheap to run in parallel because none of them needs the others' findings.

Review does not edit, commit or land the work it inspects.

## A factory turn

The brief carries only what this skill cannot know: the `order`, the `workspace`, the `build` (the Build artifact), the `diff` (the order's diff against the default branch), the `answers` the builder gave to the last round's findings, and `returned` (why the order came back). Read that diff and the Build artifact, and nothing about how the change came to be. Raising nothing is the expected result when the diff is sound.

The turn ends in one of three returns:

- **Findings.** Write a JSON array to a file under `$TMPDIR`, each `{"area", "file", "line", "failure", "fix", "severity"}`, and run `dim review return --findings <file>`. Every finding blocks, at `critical`, `high` or `medium`; a point that would not block is left out. A finding from an earlier round that still holds at this head is raised again, with why its answer does not settle it.
- **The Review artifact.** When nothing blocks, write `{"body", "covered", "setAside", "unverified"}` to a file under `$TMPDIR` and run `dim review return --artifact <file>`. `body` follows `dim-artifact`: whether the diff does what the Build artifact says, then what a careful reader should know. `covered` names every area below that ran; `setAside` what was left out as outside the order; `unverified` each claim that could not be checked and what would settle it.
- **A problem in the build.** When the Build artifact claims what the diff does not do, and the fix is the builder's rather than a finding's, run `dim order return --reason "<the problem>"`.

A reply naming what is missing records nothing: fix the return and send it again. `dim order show` prints the order and `dim query` reads the record.

## Entry contract

Before spawning anything:

1. **Size the diff**, and split it when it combines unrelated work or is too large to review as one logical change. A review that cannot hold the change is not evidence that the change is sound.
2. **Read the tests first**, then get the intent behind the diff from the Build artifact. Tests reveal the behavior the change claims and the failure paths the author considered; the intent explains what the tests cannot.

## The passes

Spawn one agent per area, each given the diff, the intent, its brief from [quality areas](references/quality-areas.md), and only the grounding below, and each with read-only tools. Withhold your own read of the diff — hand over a conclusion and what comes back is agreement with it. A reviewer that can edit answers a finding by editing, and what it overwrites is work it was sent to read.

| area | what it reads against |
|---|---|
| conformance | whether the diff does what the Build artifact says, naming work that is missing, extra or misunderstood |
| correctness | read the diff and the code it calls |
| tests | a test claiming an invariant must fail when it is removed; a bug fix's test must fail on the bug |
| architecture | use `dim query prior-art "<path fragment>"` as grounding |
| maintainability | use the glossary, project rules and nearby patterns |
| docs | read the docs that describe the changed behavior |
| security | read the diff and project rules |
| performance | read the diff for repeated work, unbounded operations and resource misuse on the paths it changes |
| style | whether naming, structure and local patterns remain consistent without adding comments or abstraction noise; read the diff and project rules |

Every pass runs. Maintainability stays a normal pass because every change leaves code for the next worker. Both it and performance need concrete evidence; a preference or hypothetical cost is not a finding. A bug fix is checked for repairing the cause rather than a symptom.

## Exit check

The review is done when:

- every area ran, and one whose agent failed to return is named under `unverified` rather than quietly dropped
- each finding names a file the diff changed and a line that file has at the head commit, what fails, the fix direction and a blocking severity — a finding with no failure case is an opinion
- every earlier finding the brief lists was read against this head
- findings that contradict each other are resolved here, not passed on as a list
- every finding an area raised was checked at its source before it was passed on, cited to `file:line`

A finding is a claim, and a claim carried forward unchecked is how a wrong one becomes the standard. Checking it is this station's work whether or not the reviewer wrote the code.

## See also

- `dim-artifact`

## Red flags

- reporting a finding without a concrete failure path
- reviewing only the implementation and not the tests or intent
- returning the Review artifact while a finding still blocks
- accepting a clean process exit as a clean review

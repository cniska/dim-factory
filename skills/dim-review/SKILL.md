---
name: dim-review
description: Review an order's whole diff against its Build artifact, one agent per area, and return findings or the Review artifact. Use as the reviewer, when a brief names dim-review.
---

# Review

The brief carries the `order`, the `workspace`, the `build` (the Build artifact), the `diff` (the order's whole diff against the default branch), the `answers` the builder gave the last round's findings and `returned` (why the order is back at review, when it is).
## Returns

- Findings. Write a JSON array to a file under `$TMPDIR`, each `{"area", "file", "line", "failure", "fix", "severity"}` with severity `critical`, `high` or `medium`, and run `dim review return --findings <file>`. Every finding blocks; a point that would not block is left out. The order goes back to build, and the builder answers each finding once.
- The Review artifact. Write `{"body", "covered", "setAside", "unverified"}` to a file under `$TMPDIR` and run `dim review return --artifact <file>`. `body` follows [artifact](references/artifact.md), the outcome first and drawn from the record, and says whether the diff does what the Build artifact says; `covered` names each area that ran; `setAside` what was left out as outside the order; `unverified` each claim that could not be checked and what would settle it.
- `dim order return --reason "<the problem>"` when the Build artifact claims what the diff does not do and the fix is the builder's rather than a finding's.

A reply naming what is missing records nothing: fix the return and send it again. A second miss fails the station. `dim order show` prints the order, and `dim message send <text>` leaves the operator a note it reads after the turn.

## What the gates proved

Each commit passed the project's check on its own code when the gates kept it, with the check's declaration unchanged. After a rebase only the branch's head was checked again. Read for what reading alone can show.

## The passes

Read the tests first, then the Build artifact for the intent. Then one agent per area, each with read-only tools, the diff, the intent, the project's rules and its own question, and not your own reading. The areas and their questions are in [quality areas](references/quality-areas.md), with two more that only a change has:

| Area | Reads against |
|---|---|
| Conformance | Whether the diff does what the Build artifact says, naming work that is missing, extra or misunderstood |
| Style | Whether naming, structure and local patterns stay consistent, with no comment or abstraction noise |

Architecture takes `dim query prior-art "<path fragment>"` as grounding. For a defect, [bug](references/bug.md) under Review.

## Before returning

- Each finding names a file the diff changed, a line that file has at the head commit, what fails, the fix and its severity.
- An earlier finding whose answer does not settle it at this head is raised again, saying why.
- An area whose agent did not return is named under `unverified`.

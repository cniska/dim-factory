---
name: dim-build
description: Build an approved plan slice by slice — write, verify, simplify, check for correctness and pattern fit, and commit each slice through the gates, answering every finding. Use as the builder, when a brief names dim-build.
---

# Build

The brief carries the `order`, the `workspace`, the approved `plan` with each slice's `commit` once it has one, `returned` (why the order is back at build, when it is), the open `findings` by id and a `conflict` from a ship. One turn builds every slice without a commit, in order, answers every finding and returns once.

## Commands

- A commit made under `dim-git`, then `dim slice submit`, hands a slice in. The gates keep it when it is one new commit on the recorded head, it leaves the check's declaration as it was, the workspace is clean and the project's check passes on it without changing a file. A refused slice's reply names the code and the branch is back where it was, with the changes still in the workspace: fix the cause, commit and submit again.
- `dim finding answer <id> fixed --reason "<what changed>"` or `dim finding answer <id> refused --reason "<why not>"`, once per finding the brief lists, after its fix is submitted.
- `dim order return --reason "<the problem>"` when the plan cannot be built as approved. Committed slices stay on the branch and the problem reaches the planner.
- `dim build return <file>` with the Build artifact, written under `$TMPDIR`, once every slice is committed, the branch holds nothing unsubmitted, the workspace is clean and every finding is answered. A reply naming what is missing records nothing: finish it and return again. A second miss fails the station.
- `dim order show` prints the order. `dim message send <text>` leaves the operator a note it reads after the turn.

## A slice

1. Know the check. It is the task the project declares, `verify` first, then `check`, `ci`, `validate` or `test`, in `package.json`, `mise.toml` or a `Makefile`, and it is what `dim slice submit` runs on the commit. Run that task, not a command assembled by hand.
2. Name the data shape before writing logic: the types, states and transitions the slice adds, as the plan has them.
3. Write the slice. A slice that changes behavior follows `dim-tdd`; a defect follows [bug](references/bug.md) under Build. A slice that replaces code lists every branch of the code it replaces and maps each to where it now lives; a branch with no mapping is a dropped behavior, named as a cut or restored. An edit repeated across many sites is a codemod over the parsed code, whose diff is read and whose misses are edited by hand.
4. Run the check and read its output.
5. Simplify under `dim-simplify`, then run the check again.
6. Hand the slice's diff to two agents with read-only tools, each with a fixed brief, the project's rules and what the slice claims to do, and not your own reading. One reads for correctness: does every invariant the diff claims have a test that fails without it; does a fallback, default or catch-and-continue stand in for a decision never made; did the doc describing this behavior change in the same diff. The other reads for pattern fit, the Architecture question in [quality areas](references/quality-areas.md). The first slice in a new area gets the closest read, because every later slice copies it.
7. Answer each finding before the commit. Check the claim at its source, then fix it, or refuse it and say why. Run the check over the answers and hand the reviewer the answering diff with the same brief. The loop ends when no finding is unanswered, never when none exists.
8. Commit and submit.

## Review findings

A finding the brief lists is a reviewer's claim: check it at its source. Fix it in a commit through the gates, then answer it. Refuse it with a reason when it is wrong, or true and outside the order.

## A conflict

A `conflict` in the brief means the ship's rebase onto the default branch stopped on the named paths, and the workspace is at the order's recorded head. `dim-git` holds the rebase; `dim slice submit` then hands in the rebased branch.

## The Build artifact

It follows `dim-artifact`. Its sections: the outcome; what changed, grouped by behavior; why this shape and what was not taken; what the checks establish; where the build departed from the plan, and what a careful reader should look at. On a returned Build artifact, the code changes where the reason asks for a change, the artifact where it does not.

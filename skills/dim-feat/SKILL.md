---
name: dim-feat
description: Build a feature — scope it against what this machine already did, cut it into slices that each verify on their own, then build them one at a time. Use when adding functionality rather than repairing it.
argument-hint: "<what to build>"
---

# Feature

The front door for new work. It runs the whole line: scope, then the slice loop in `dim-build`. You type this once; it invokes what it needs.

When `dim-factory` assigns an order, work in the order worktree that `dim order plan` created. The factory runner owns its checkout, check, commit, and recorded evidence.
The approved plan supplies the order's scope and slices; report a plan defect to the operator for return to planning. The factory Review station reads the completed order.

Use `dim-git` for the worktree ownership, commit evidence and integration boundaries; this line decides the feature's scope and slices, not a second Git policy.

What makes this front different from `dim-fix` is the shape of the work rather than a preference. A feature touches more files than one slice holds, so the hard part here is the cut, and that is what phase 1 buys.

## Scope

Find out what is already on disk before designing anything.

- **Has this shape been built here before?** `dim q prior-art "<path fragment>"` names every tracked file whose path matches, across the repos on disk. It matches a path, so a concept whose file is named for its domain is invisible to it.
- **Was this already decided?** A decision already taken is not yours to re-take. `dim q search "<words the decision would use>"` reaches one settled in conversation and never written down.

**Use `dim-plan` where the cut is not obvious from those answers** — where the work crosses repos, changes a contract other code depends on, or has two shapes worth weighing. That station asks the questions in full and hands the planning to a more capable model. Where the scope is one repo and the slices fall out of the reading, say so in a line and cut them here; loading a planning station to confirm an obvious cut spends context on agreement.

If the queries came back empty, say that. An empty record is a fact about the work being new and is worth more written down than silently skipped.

## Cut it into slices

A slice changes behavior and is checked on its own. Name them before editing, and name what checks each — the repo's own task, so that what runs locally is what CI runs. Outside a factory order, commit each passing slice; for an order, the runner commits it after the turn.

A slice that only makes sense once a later slice lands is not a slice. A branch of unverified slices is one slice with a long diff.

## Build them

Use `dim-build` one slice at a time: the repo's own task at the end of each, the simplification pass over that slice, the task again, one checking agent on the slice's diff, an answer to every finding it raises, then the commit boundary, then the next.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## Review the assembled change, where there was more than one slice

Each slice was checked against its own diff, and nothing has yet read them together — a contract two slices agreed on separately, or a shape that only went wrong once both landed, is invisible to a per-slice check. Use `dim-review` over the range the slices span.

One slice means this is already done: reviewing the same diff a second time is the checking agent's job run twice.

## Exit check

The feature is done when:

- every slice named in phase 2 is committed, or is named as left out with its reason
- a change that ran to more than one slice was reviewed as a whole
- the repo's own task passes, and its output was read rather than assumed
- every invariant claimed has a test that fails when the invariant is removed
- the docs describing the new behavior changed in the same commit as the behavior

## What the record cannot tell you

`dim q prior-art` cannot tell a file that was got right from one that was abandoned, and a file copied between repos looks as settled as one that was worked out. Use it to find the reading, and do the reading.

Effort is not a grade either: a slice finished quickly is not a slice done well, and the check that was skipped is the usual reason it was quick.

## Red flags

- cutting slices by file rather than by independently verifiable behavior
- starting implementation before the scope and dependencies are clear
- skipping whole-change review because each slice passed alone
- treating effort or slice count as evidence of quality

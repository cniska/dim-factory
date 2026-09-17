---
name: dim-feat
description: Build a feature — scope it against what this machine already did, cut it into slices that each verify on their own, then build them one at a time. Use when adding functionality rather than repairing it.
argument-hint: "<what to build>"
---

# Feature

The front door for new work. It runs the whole line: scope, then the slice loop in [`dim-build`](../dim-build/SKILL.md). You type this once; it invokes what it needs.

What makes this front different from [`dim-fix`](../dim-fix/SKILL.md) is the shape of the work rather than a preference. A feature in the owner's own repos touches 30 files against a fix's 10 ([`findings.md`](../../docs/findings.md)). Thirty files is not one slice, so the hard part here is the cut, and that is what phase 1 buys.

## 1. Scope

Find out what is already on disk before designing anything.

- **Has this shape been built here before?** `dim q prior-art "<path fragment>"` names every tracked file whose path matches, across the repos on disk. It matches a path and not a meaning, so a concept whose file is named for its domain is invisible to it — `dim q search "<the question, in your words>"` is the one that ranks by meaning, over the text a person distilled.
- **Was this already decided?** A decision already taken is not yours to re-take. `dim q keywords "<words>"` reaches one settled in conversation and never written down, which is the case `q search` is worst at. `dim q chain <id-prefix>` and `dim q resume <id-prefix>` say whether this is mid-chain with a Next already written.

**Invoke [`dim-plan`](../dim-plan/SKILL.md) where the cut is not obvious from those answers** — where the work crosses repos, changes a contract other code depends on, or has two shapes worth weighing. That station asks the four questions in full and hands the planning to a more capable model. Where the scope is one repo and the slices fall out of the reading, say so in a line and cut them here; loading a planning station to confirm an obvious cut spends context on agreement.

If the queries came back empty, say that. An empty record is a fact about the work being new and is worth more written down than silently skipped.

## 2. Cut it into slices

A slice changes behavior, is checked on its own, and is committed on its own. Name them before editing, and name what checks each — the repo's own task, so that what runs locally is what CI runs.

A slice that only makes sense once a later slice lands is not a slice. A branch of unverified slices is one slice with a long diff.

## 3. Build them

Hand off to [`dim-build`](../dim-build/SKILL.md) and follow it, one slice at a time: the repo's own task at the end of each, the simplification pass over that slice, the task again, one checking agent on the slice's diff, then the commit, then the next.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## 4. Review the assembled change, where there was more than one slice

Each slice was checked against its own diff, and nothing has yet read them together — a contract two slices agreed on separately, or a shape that only went wrong once both landed, is invisible to a per-slice check. Invoke [`dim-review`](../dim-review/SKILL.md) over the range the slices span.

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

Effort is not a grade either. Work that held took more turns per file than work that came back ([`findings.md`](../../docs/findings.md)) — a slice finished quickly is not a slice done well, and the check that was skipped is the usual reason it was quick.

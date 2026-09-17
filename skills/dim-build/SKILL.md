---
name: dim-build
description: Build a change in vertical slices, aimed by the files this machine's record says have broken before, and checked by the repo's own task. Use when implementing a feature or a fix across more than one file.
argument-hint: "<what to build>"
---

# Build

One agent, in one session. The work is edits, and edits need the context that produced them to stay coherent across slices; a subagent returns a conclusion and keeps its evidence. That is a good trade for a review, where findings are the product, and a bad one here.

This is a decision to measure rather than a principle. `build` has handed work to a subagent five times in the whole corpus, so nothing says fan-out is worse here — it says nobody has tried it. The review arm that did fan out is confounded by being review ([`findings.md`](../../docs/findings.md), "Delegating has cost nothing measurable"). Fan-out in a build is a change that earns its way in through a measured arm, not an assumption.

What makes this a station is that the record aims it. This machine knows which files a later `fix:` commit had to come back to, which shipped untouched, and what the owner has had to say more than once.

## Entry contract

1. **Know what checks this.** Read the repo's own task — `package.json` scripts, `mise` tasks, a `Makefile` — and use it. Running the repo's task is what makes a local check the same check CI runs; an equivalent command assembled by hand is not that.
2. **Find the ground that has broken.** `dim q fixes` names files an agent edited that a later fix commit came back to. A path in this change that appears there gets the slow reading and a test before the edit, not after.
3. **Check for a standing correction.** `dim q repeats` gives the phrases the owner has used across several sessions when stopping or correcting an agent. A phrase that recurs is a rule that is not landing; find where it lives before writing code that breaks it again.
4. **Pick up rather than restart.** If a session already worked this, `dim q resume <id-prefix>` gives the branch, the files in play and the last pushback.

## Slices

A slice is a vertical cut: it changes behavior, it is checked on its own, and it is committed on its own. Work through them one at a time, running the repo's task at the end of each, and commit what passes before starting the next. A branch of unverified slices is one slice with a long diff.

Commit in the same order: task passes, then commit, then the next slice. The subject follows Conventional Commits — one line, under 50 characters, ASCII, naming what changed and nothing about why or how the work went. `dim install-commit-gate` holds that rule as a `commit-msg` hook for every repo on the machine, so a subject that breaks it is refused at commit time rather than found later; `dim check-commits <range>` judges what already landed. `dim q slices` then reads the record back and says which commits had a verified run in front of them.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## Exit check

The change is done when:

- the repo's own task passes, and its output was read rather than assumed
- every invariant claimed has a test that fails when the invariant is removed — delete the check, watch it go red, put it back
- the docs that describe the changed behavior changed in the same commit
- anything left out is named, with the reason

## When to stop and ask

Unattended, stop only where the choice is genuinely the owner's: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session rather than this one. Everything else is settled here and stated. A question a query could have answered should have been a query.

## What the record cannot tell you

`dim q fixes` says a file drew a later fix commit. That is the repo's verdict on some earlier change to it, never on yours, and a file nobody came back to may have been right or may have been abandoned.

And effort is not a grade. Work that held took more turns per file than work that came back, more pushback, and more commands ([`findings.md`](../../docs/findings.md), "Effort does not grade the work"). A slice finished quickly is not a slice done well, and the check that was skipped is the usual reason it was quick.

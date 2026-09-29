---
name: dim-fix
description: Fix a defect — triage it against what this machine already knows about these files, prove it with a failing test, then build the fix in slices. Use when something is broken, a test fails, or behavior does not match what was intended.
argument-hint: "<what is broken>"
---

# Fix

The front door for a defect. It runs the whole line: triage, a test that fails on the bug, then the slice loop in `dim-build`. You type this once; it invokes what it needs.

In a factory order, each phase belongs to one station, and the runner owns the checkout, check, commit and recorded evidence:

- **Plan** runs Triage. The plan names the cause and the line believed wrong; where triage found no defect, the plan says so and proposes no fix, and the owner drops the order.
- **Build** runs Prove it and Build the fix in the order worktree, against the cause the approved plan names. A plan defect goes back to the operator for return to planning.
- **Review** holds the diff to the exit check: the named cause is fixed rather than a symptom, and a test in the diff fails without the fix.

Use `dim-git` for the worktree ownership, commit evidence and integration boundaries; this line decides the defect's cause and fix slices, not a second Git policy.

The record says why this is one station and not three pointers. `debug` has loaded in 9 sessions in this corpus, against 1,470 `fix:` commits in the owner's own repos ([`findings.md`](../../docs/findings.md)). A phase named in prose is a phase that does not run — so triage is performed here rather than delegated to a skill the agent has to remember.

A fix is also smaller than a feature and localized differently: 10 files to a feature's 30. That is why the slicing phase is borrowed rather than owned, and the reading phase is owned rather than borrowed.

## Triage

Establish what is wrong before changing anything. The record aims this, because these files have a history.

- **What was already tried.** `dim q search "<words the symptom would use>"` finds an attempt that was only ever talked about, and `dim q thread` reads the exchange around a hit. A fix already attempted and abandoned is a fact worth having before attempting it again.
- **What the trace says.** Where the defect arrived as a report rather than a description, read the report before the code. A stack, a log, or a fault body says which line ran; a description says what someone noticed.

Form one explanation that accounts for every symptom, and name the line you believe is wrong. Two candidate explanations means triage is not finished — the test in phase 2 is what distinguishes them.

## Prove it

**Where triage found no defect, stop here and say so.** That is a finding, not a failure of the station: the behavior is intended, or the report was about something else. Report what the code actually does and why it is right, and do not write a test to justify having started.

Otherwise, write the test that fails because of this defect, and watch it fail, before editing the code it covers.

This is the gate between reading and editing, and skipping it is how a fix lands on a symptom. A test written after the fix passes for the wrong reason more often than it catches anything: it was written against code that already worked. Where the defect is in a parser, an auth path, a signing step or anything that fails closed, this phase is not optional.

The test names the behavior in plain terms, and pins wire values as literals rather than importing the production constant, so a rename cannot ratify itself.

In a factory order, name each test file that proves the defect in the build turn's `tests`. The runner runs the proof itself, the declared check at the slice's base with only those files laid over it, and refuses the slice `proof_green` when they pass there. The runner counts any failure of the check as red, so a test that fails there only because it imports what the fix adds passes the gate and proves nothing; it has to fail on the defect in the code as it was.

## Build the fix

Use `dim-build` and follow it: the repo's own task at the end of each slice, the simplification pass over that slice, the task again, one checking agent on the slice's diff, an answer to every finding it raises, then the commit boundary. The test that proved the defect is part of the slice and stays; the simplification pass is the one step that may not touch a test file. A fix is usually one slice; where it is more, it is still one slice at a time.

Fix the cause. Where the cause is out of reach, stop and say what the real options are rather than patching the patch — a band-aid is how the next fix commit to this file gets written.

Where the fix ran to more than one slice, invoke `dim-review` over the range they span before calling it done: each slice was checked against its own diff, and nothing has yet read them together. One slice needs none — that is the checking agent's job run twice.

## Exit check

The fix is done when:

- a test fails without it and passes with it, and that was watched in that order; in a factory order the proof row records the red, and Review judges from the test itself that it fails because of the defect
- the repo's own task passes, and its output was read rather than assumed
- the cause is named — in the commit subject in plain words, and in a comment only where a reader would otherwise break the constraint again
- the docs describing the changed behavior changed in the same commit

## Red flags

- fixing before proving the defect with a failing test
- treating a symptom as the cause
- broadening a fix beyond the named behavior
- skipping the slice loop because the fix looks small

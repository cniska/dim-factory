---
name: dim-fix
description: Fix a defect — triage it against what this machine already knows about these files, prove it with a failing test, then build the fix in slices. Use when something is broken, a test fails, or behavior does not match what was intended.
argument-hint: "<what is broken>"
---

# Fix

The front door for a defect. It runs the whole line: triage, a test that fails on the bug, then the slice loop in [`dim-build`](../dim-build/SKILL.md). You type this once; it invokes what it needs.

The record says why this is one station and not three pointers. `debug` has loaded in 9 sessions in this corpus, against 1,470 `fix:` commits in the owner's own repos ([`findings.md`](../../docs/findings.md)). A phase named in prose is a phase that does not run — so triage is performed here rather than delegated to a skill the agent has to remember.

A fix is also smaller than a feature and localized differently: 10 files to a feature's 30. That is why the slicing phase is borrowed rather than owned, and the reading phase is owned rather than borrowed.

## 1. Triage

Establish what is wrong before changing anything. The record aims this, because these files have a history.

- **What broke here before.** `dim q fixes` names files an agent edited that a later fix commit came back to. A path in this defect that appears there gets the slow reading.
- **What was already tried.** `dim q search "<the symptom, in your words>"` ranks the text a person distilled; `dim q resume <id-prefix>` gives the branch, the files in play and the last pushback of a session that worked this. A fix already attempted and abandoned is a fact worth having before attempting it again.
- **What the trace says.** Where the defect arrived as a report rather than a description, read the report before the code. A stack, a log, or a fault body says which line ran; a description says what someone noticed.

Form one explanation that accounts for every symptom, and name the line you believe is wrong. Two candidate explanations means triage is not finished — the test in phase 2 is what distinguishes them.

## 2. Prove it

Write the test that fails because of this defect, and watch it fail, before editing the code it covers.

This is the gate between reading and editing, and skipping it is how a fix lands on a symptom. A test written after the fix passes for the wrong reason more often than it catches anything: it was written against code that already worked. Where the defect is in a parser, an auth path, a signing step or anything that fails closed, this phase is not optional.

The test names the behavior in plain terms, and pins wire values as literals rather than importing the production constant, so a rename cannot ratify itself.

## 3. Build the fix

Hand off to [`dim-build`](../dim-build/SKILL.md) and follow it: the repo's own task at the end of each slice, one checking agent on the slice's diff, then the commit. A fix is usually one slice; where it is more, it is still one slice at a time.

Fix the cause. Where the cause is out of reach, stop and say what the real options are rather than patching the patch — a band-aid is how the next fix commit to this file gets written.

## Exit check

The fix is done when:

- a test fails without it and passes with it, and that was watched in that order
- the repo's own task passes, and its output was read rather than assumed
- the cause is named — in the commit subject in plain words, and in a comment only where a reader would otherwise break the constraint again
- the docs describing the changed behavior changed in the same commit

## What the record cannot tell you

`dim q fixes` says a file drew a later fix commit. That is the repo's verdict on some earlier change to it, never on yours, and a file nobody came back to may have been right or may have been abandoned. A `fix:` commit inside the session that wrote the file is ordinary iteration and not a defect at all.

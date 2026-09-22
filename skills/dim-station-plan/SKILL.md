---
name: dim-station-plan
description: Scope a change against what this machine already did — prior art on disk, decisions already taken, and whether an earlier conclusion still holds. Invoked by dim-line-feat where the cut is not obvious; use directly only to scope work that is not yet a feature or a fix.
argument-hint: "<what you are about to build>"
---

# Plan

A plan written without reading the record re-derives what is already on disk. This machine holds every session it has run, every commit those sessions led to, and every file each commit touched. So the four questions below are queries rather than guesses, and each one can delete a branch of the plan before it is written.

This is what separates a station from a checklist: the checklist is the same everywhere, and these answers are about this machine.

## Entry contract

Answer all four before proposing an approach.

1. **Has this shape been built here before?** `dim q prior-art "<path fragment>"` names every tracked file whose path matches, across the repos on disk, dated by the commits that touched it. Every path it prints opens, so the answer is a file to read rather than a memory. Read the repo column before the file — a repo that was only cloned ranks beside the owner's own — and treat recency and commit count as where to look, never as quality.

2. **Was this already decided?** `dim q search "<the question, in your words>"` ranks the text a person distilled by hand — handoff Nexts, their own commit subjects — by meaning. A decision settled in conversation and never distilled is not in that index, and `dim q keywords "<the question, in your words>"` is what reaches it, over every message anyone said. A decision already taken is not yours to re-take; find it and say what it settled. Where both come back empty and only a file sweep will answer, the planner sweeps for itself: it reads the repo under the same fixed question, and a separate hand to search would return a conclusion whose grounds the planner then could not check.

3. **Is this a continuation?** `dim q chain <id-prefix>` gives the sessions either side of one, joined by the handoff between them, and `dim q resume <id-prefix>` gives the branch, the files in play and the last pushback. Work that is mid-chain has a Next already written, and planning over it is how the same thing gets built twice.

4. **Does the earlier conclusion still hold?** `dim q stale <id-prefix>` says how much the code a session touched has moved since it ran. High movement is evidence to re-read what that session concluded, never evidence it was wrong.

## Design the change

The four answers are evidence, not the design. Use `dim-design` with the task, the current project context and the record's returned facts. Let it define the outcome, boundary, invariants and independently verifiable slices. The design skill is reusable across projects; this station supplies the record evidence and keeps the result attributable to the planning hand.

Pass the record's returned facts rather than your reading of them: hand over a conclusion and what comes back is agreement with that conclusion.

Ask the owner only when the choice is genuinely theirs, which is narrower than it feels. It is theirs when the work is hard to reverse, when it is outward-facing, or when it spends something that lands on every session rather than this one. Everything else — which of two shapes, what to name it, what order to slice it in — is settled here and stated, not asked. A question that a query could have answered is a question that should have been a query.

## Check the plan before acting on it

A plan is cheaper to fix than the code written from it, so it gets the same treatment a slice gets in `dim-station-build`: one agent at the tier `dim route codex reviewer` gives you, working from a fixed brief, and not the agent that wrote the plan. Give it the plan and what the four queries returned — not the reasoning that got there, or what comes back is agreement.

The brief is these questions:

- is every slice a cut that can be verified on its own, or does one of them only make sense once a later slice lands
- does each slice name the repo's own task as its check, rather than a command assembled by hand
- does the plan say what the record returned and what that removed, or does it read as though nothing was looked up
- does anything here ask the owner a question one of the four queries could have answered

Returning nothing is the expected result. A reviewer earns trust the way a test does — plant a defect once, watch it be caught, take it out.

## Exit check

The plan is done when it names:

- the slices, each a vertical cut that can be verified on its own
- what checks each slice — the repo's own task, so what runs locally is what CI runs
- what the record returned, and what that removed or changed
- what is still unknown, and the one question that would settle it

If all four queries came back empty, say that in the plan. An empty record is a fact about the work being new, and it is worth more written down than silently skipped.

## What the record cannot tell you

The record is process: what was said, run, loaded and stopped. It cannot say whether any of it was right. `dim q prior-art` cannot tell a file that was got right from one that was abandoned, and a file copied between repos looks as settled as one that was worked out. Use it to find the reading, and do the reading.

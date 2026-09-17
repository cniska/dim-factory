---
name: dim-build
description: Run the slice loop — the repo's own check, a checking agent on the diff, then the commit, one slice at a time. Invoked by dim-feat and dim-fix after their own first phase; use directly only for a change that is neither.
argument-hint: "<what to build>"
---

# Build

The shared half of both fronts. [`dim-feat`](../dim-feat/SKILL.md) arrives here having cut the work into slices; [`dim-fix`](../dim-fix/SKILL.md) arrives with a failing test and a named cause. What follows is the same either way.

One agent, in one session. The work is edits, and edits need the context that produced them to stay coherent across slices; a subagent returns a conclusion and keeps its evidence. That is a good trade for a review, where findings are the product, and a bad one here.

This is a decision to measure rather than a principle. `build` has handed work to a subagent five times in the whole corpus, so nothing says fan-out is worse here — it says nobody has tried it. The review arm that did fan out is confounded by being review ([`findings.md`](../../docs/findings.md), "Delegating has cost nothing measurable"). Fan-out in a build is a change that earns its way in through a measured arm, not an assumption.

What makes this a station is that the record aims it. This machine knows which files a later `fix:` commit had to come back to, which shipped untouched, and what the owner has had to say more than once.

## Entry contract

1. **Know what checks this.** Read the repo's own task — `package.json` scripts, `mise` tasks, a `Makefile` — and use it. `dim check-task` prints what the repo declares. Running the repo's task is what makes a local check the same check CI runs; an equivalent command assembled by hand is not that.
2. **Read the rules actually in force.** The standing corrections live in the guidance files, not in a phrase counter — `dim q repeats` returns conversational filler and the corrections are not in it ([`findings.md`](../../docs/findings.md), "The repetition an n-gram counter cannot see"). Read the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included, and treat a rule a session has already restated as one that is not landing rather than one the agent ignored.
3. **Know which ground has broken.** `dim q fixes` names files an agent edited that a later fix commit came back to. A path in this change that appears there gets the slow reading. A front arriving here has already asked this; a change that came in directly asks it now.

## Slices

A slice is a vertical cut: it changes behavior, it is checked on its own, and it is committed on its own. Work through them one at a time, running the repo's task at the end of each, and commit what passes before starting the next. A branch of unverified slices is one slice with a long diff.

Commit in the same order: task passes, then commit, then the next slice.

**The subject follows the repo's own convention, and `dim q convention <repo>` is where that is read rather than inferred.** It gives the share of subjects that are Conventional Commits, their mean length, and how much of the history arrived through a branch — the questions the tool-agnostic advice answers by skimming `git log`, over the whole log instead of a sample. Where the repo is not in the record, read the log.

`dim install-commit-gate` holds the owner's own subject rule as a `commit-msg` hook for every repo on the machine, so a subject that breaks it is refused at commit time rather than found later, and `pre-push` refuses a push that rewrites the branch the remote's HEAD names. `dim check-commits <range>` judges what already landed, and `dim q slices` reads the record back for which commits had a verified run in front of them.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## Check the slice before the next one

Between the task passing and the commit, hand the slice's diff to one agent working from a fixed brief. This is not the fan-out the top of this file argues against: that objection is about delegating the edits, which need the context that produced them. A checker returns findings and keeps nothing, which is the trade [`dim-review`](../dim-review/SKILL.md) makes and the one the corpus measured as costing nothing.

Bounded means a fixed brief, not "review this". It also means the checker is told what to look for: hand it the conventions actually in force — the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included — because the rules it is checking against are written down and a checker left to invent them checks its own taste. Give it the diff of this slice alone, what the slice claims to do, and these four questions:

- does every invariant the diff claims have a test that fails without it
- does any comment narrate the change — what the code used to do, what was renamed, what is now different — rather than state the constraint that forced this approach
- did a doc describing this behavior change in the same diff
- is there a fallback, default or catch-and-continue standing in for a decision that was never made

Withhold your own reading. Hand over the diff and the claim, not the conclusion, or what comes back is agreement.

Act on what it returns or say why not, then commit. Returning nothing is the expected result and not a sign the check was wasted: of the sessions that loaded `review` in this corpus, 72% made no edit under it ([`findings.md`](../../docs/findings.md), "Review already finds nothing, most of the time"). A checker earns trust the way a test does — plant a defect once, watch it be caught, take it out — and after that an empty result is the good news it reads as.

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

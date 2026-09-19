---
name: dim-rules
description: Maintain the standing instructions agents load, machine-wide or in one repo, and the tool files that import them. Use when adding, sharpening or removing a rule, not when writing a doc that argues for one.
argument-hint: "<the rule you want to land>"
---

# Rules

A rule costs tokens on every session that loads it and changes nothing on the sessions that do not. So the question is never whether the rule is true. It is which layer it belongs in, whether a gate could hold it instead of a sentence, and whether it is already written somewhere this reader will reach.

This machine can answer all three from what it has already run, which is what separates this from editing the file by hand.

## Entry contract

Answer these before writing a line.

1. **Is this rule already settled?** `dim q search "<the rule, in your words>"` ranks what a person distilled — handoff Nexts, their own commit subjects — by meaning, and `dim q keywords "<words>"` reaches what was said and never distilled. A rule re-litigated is a rule that will be re-litigated again; find what settled it and sharpen that instead.

2. **Is it actually being broken?** `dim q corrections` gives the turns the user physically stopped, by skill, and `dim q rework` gives the files an agent had to revisit after a pushback. A rule nobody breaks is a line paid for on every session to prevent nothing. A rule broken repeatedly under one skill belongs in that skill, not in the file every session loads.

3. **What does the repo already do?** `dim q convention <repo>` reads the commit format off that repo's own log rather than off anyone's memory of it. What a repo does is the rule; a file that states something else is the thing that is wrong.

4. **Does the concept already have a word?** Read [`docs/glossary.md`](../../docs/glossary.md). A rule that introduces a second word for a thing already named costs more than it states, because from then on both words are searched and only one is found.

## Choose the layer before choosing the words

A rule can live in any of these, and the cost falls as you go down:

- **The machine-wide rules**, read on every session in every repo. The most expensive line there is, so it holds only what is true of all work everywhere — how to commit, how to comment, how to verify a claim.
- **One repo's rules**, read on every session in that repo. Only what holds there and nowhere else. A general convention restated here is paid for twice and is a second place for it to drift.
- **A station skill**, read when that station runs. A rule governing one operation goes here, where it arrives exactly when it applies.
- **A doc**, read when the argument is needed. The reasoning, the measurement, the case that was weighed — never the rule itself, or the two drift.
- **The record**, read by a query. A fact, not a rule: what was decided, what a number was, which version shipped.

Put the rule in the lowest layer that still reaches the work, and ask the machine-wide question first: does this hold everywhere, or only here? A rule that holds everywhere and sits in one repo is a rule the other repos break for free. A rule that holds in one repo and sits machine-wide is a line every unrelated session pays for.

The commonest defect is a rule placed high because it felt important, which is how a file every session pays for grows past what any session reads.

## Prefer a gate to a sentence

Before writing prose, ask what could refuse. A subject's length, a schema version, an exit code, a shape rather than a meaning — all of those are gates, and a gate holds whether or not anything was read. A sentence holds only when a model read it and chose to comply.

Where the rule needs judgement, it stays a sentence and says so. Where it does not, the sentence is a stopgap for a gate that was not written, and it says that too, so the next agent knows what to build rather than what to restate.

## Merge, never append

Read the whole file first. Then:

- A rule overlapping an existing one rewrites that one, and does not sit beside it.
- A rule that generalizes several replaces them.
- A rule stated in two places is deduped to the one place its reader will reach.

A file that only ever grew is a file nobody finished reading.

## Exit check

The change is done when:

- the rule sits in the lowest layer that reaches the work, and the choice is defensible out loud
- nothing was appended that an existing line could have absorbed
- every word in it is the word the glossary uses, or the glossary now holds the new one
- what is mechanical is a gate, or is named as a gate still to build
- the file is shorter than it would have been, or the growth bought something no existing line carried

## What the record cannot tell you

The record is process: what was said, run, loaded and stopped. `dim q corrections` counts the turns a user stopped, not the ones they should have. A rule broken often may be a rule worth holding harder or a rule worth deleting, and nothing here can tell those apart — it tells you where to look, and the judgement is still yours.

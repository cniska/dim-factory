---
name: dim-rules
description: Maintain the standing instructions agents load, machine-wide or in one repo, and the tool files that import them. Use when adding, sharpening or removing a rule, not when writing a doc that argues for one.
argument-hint: "<the rule you want to land>"
---

# Rules

A rule costs tokens on every session that loads it and changes nothing on the sessions that do not. So the question is never whether the rule is true. It is which layer it belongs in, whether a gate could hold it instead of a sentence, and whether it is already written somewhere this reader will reach.

## Before writing a line

1. Is this rule already settled? `dim query search "<words the rule would use>"` finds where it was said, across every session. Find what settled it and sharpen that instead.
2. Is it being broken? The same search finds each time the owner had to say it again. A rule nobody breaks is a line paid for on every session to prevent nothing. A rule broken repeatedly under one skill belongs in that skill, not in the file every session loads.
3. What does the repo already do? `git log` reads the commit format off the repo's own history. What a repo does is the rule; a file that states something else is the thing that is wrong.
4. Does the concept already have a word? Read [`docs/glossary.md`](../../docs/glossary.md). A rule that introduces a second word for a thing already named costs more than it states, because from then on both words are searched and only one is found.

## Choose the layer

A rule lives in one of these, and the cost falls as you go down:

- The machine-wide rules, read on every session in every repo. The most expensive line there is, so it holds only what is true of all work everywhere.
- One repo's rules, read on every session in that repo. Only what holds there and nowhere else; a general convention restated here is paid for twice and drifts.
- A station skill, read when that station runs. A rule governing one operation arrives exactly when it applies.
- A doc, read when the argument is needed. The reasoning, the measurement, the case that was weighed, never the rule itself.
- The record, read by a query. A fact, not a rule: what was decided, what a number was, which version shipped.

Put the rule in the lowest layer that still reaches the work. A rule that holds everywhere and sits in one repo is a rule the other repos break for free; a rule that holds in one repo and sits machine-wide is a line every unrelated session pays for.

## Prefer a gate to a sentence

Before writing prose, ask what could refuse. A subject's length, a schema version, an exit code, a shape rather than a meaning: each is a gate, and a gate holds whether or not anything was read. A sentence holds only when a model read it and chose to comply. Where the rule needs judgement, it stays a sentence. Where it does not, the sentence names the gate still to build.

## Merge, never append

Read the whole file first. A rule overlapping an existing one rewrites that one. A rule that generalizes several replaces them. A rule stated in two places is deduped to the one place its reader will reach. A file that only ever grew is a file nobody finished reading.

## Done when

- the rule sits in the lowest layer that reaches the work
- nothing was appended that an existing line could have absorbed
- every word in it is the glossary's, or the glossary now holds the new one
- what is mechanical is a gate, or is named as a gate still to build
- the file is shorter than it would have been, or the growth bought something no existing line carried

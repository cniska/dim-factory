---
name: dim-simplify
description: Simplify a completed factory slice without changing its behavior, then leave evidence that the simplification was safe.
argument-hint: "<slice or diff>"
---

# Simplify

Use this shared capability after a slice is green and before its reviewer reads it. Read the slice diff, not the surrounding codebase, and edit only where the reader's cost falls without changing behavior.

## Read the slice

Understand each changed path before rewriting it: read its callers, relevant tests and neighboring conventions. When a choice looks unnecessary, check the history or owning contract for the reason it exists. Leave it when that reason still applies. A shorter diff is not the goal; a clearer one is.

Look for a concrete reader cost in the slice:

- names that require extra memory, nested branches that carry no distinct case, and expressions that take a second read
- a function mixing computation with formatting, or branching repeatedly on the same value
- substantial duplicated logic, dead code, and wrappers that add no policy or invariant

Choose the smallest move that removes the cost. Follow the project's idioms; do not replace familiar code with a pattern merely because it matches a list. Leave a clear line alone.

## Preserve the contract

Preserve outputs, errors, side effects and their order for the same inputs. Do not remove error handling to shorten a path. Do not change tests or expand the slice to fix an unrelated design. If no edit lowers a reader cost, leave the code unchanged and record the fixpoint.

## Verify the pass

Run the repository's declared check after every simplification. The pass is complete when the last check is green and the remaining diff contains no unexplained simplification.

## Report

State whether the pass changed code and which reader cost each edit lowered. For an edited pass, name the check that proved behavior was preserved; for a fixpoint, cite the slice's existing green check. The build station then sends the resulting slice to its read-only reviewer.

## Red flags

- changing a test to make a simplification pass
- renaming without lowering reader cost
- broad cleanup outside the slice
- introducing an abstraction with one caller
- claiming behavior is preserved without rerunning the repository check

---
name: dim-simplify
description: Simplify a completed factory slice without changing its behavior, then leave evidence that the simplification was safe.
argument-hint: "<slice or diff>"
---

# Simplify

Use this shared capability after a slice is green and before its reviewer reads it. Read the slice diff, not the surrounding codebase, and edit only where the reader's cost falls without changing behavior.

## Read the slice

Look for names that require extra memory, nesting that carries no case, duplicated blocks and abstractions with one caller. A shorter diff is not the goal; a clearer one is.

## Preserve the contract

Do not change tests or behavior during this pass. Do not expand the slice to fix an unrelated design. If no edit lowers a reader cost, leave the code unchanged and record the fixpoint.

## Verify the pass

Run the repository's declared check after every simplification. The pass is complete when the last check is green and the remaining diff contains no unexplained simplification.

## Report

State whether the pass changed code, which reader cost each edit lowered, and which check proved behavior was preserved. The build station then sends the resulting slice to its read-only reviewer.

## Red flags

- changing a test to make a simplification pass
- renaming without lowering reader cost
- broad cleanup outside the slice
- introducing an abstraction with one caller
- claiming behavior is preserved without rerunning the repository check

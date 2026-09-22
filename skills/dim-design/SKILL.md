---
name: dim-design
description: Design a change in a project before implementation, using its rules, prior art and owner constraints.
argument-hint: "<what needs designing>"
---

# Design

Design the smallest stable shape that satisfies the requested outcome. The design belongs to the project being changed, not to the factory that coordinates the work.

## Entry contract

- The requested outcome is stated in project language.
- The project and its rules are known before a design is proposed.
- The design is not implementation work; it ends with a shape and slice order.

## Read the project

Before proposing a shape, read the project's instructions, the files that own the affected behavior and the documentation beside them. Search the local record when it can answer a question:

- `dim q prior-art "<path or concept>"` finds related implementations.
- `dim q search "<decision or constraint>"` finds what was settled before.
- `dim q convention <repo>` finds the repository's commit and check conventions.
- `dim q stale <session>` says whether an earlier conclusion still stands.

Read the returned files and verify their claims against the current code. An empty query result is evidence that the shape is new; it is not permission to invent history.

## Define the boundary

Write down:

- the outcome the owner needs;
- what is inside and outside the change;
- the inputs, outputs and invariants of each new boundary;
- the states and transitions the code must represent;
- the errors callers must be able to distinguish;
- the existing behavior that must remain unchanged.

Prefer names from the project. A concept gets one name, and a public boundary gets one owner. Keep provider, transport, storage and presentation details behind the boundary that owns them.

## Choose the shape

Prefer a small interface that is difficult to misuse:

- validate external data at the boundary;
- use explicit variants where outcomes differ;
- make illegal transitions fail visibly;
- preserve attribution and provenance where actions affect durable state;
- reuse an existing project pattern when it already carries the needed guarantee;
- avoid a fallback, compatibility path or abstraction without a demonstrated caller.

Separate requirements from design decisions and implementation details. Recommend one design when the choice is internal. Ask the owner only when the choice is hard to reverse, outward-facing or commits resources across sessions.

## Cut the work

Break an accepted design into vertical slices. Each slice must have one observable behavior, the project's own check, and enough documentation to leave the project readable. Put the crucial failing test before the implementation when the behavior is safety-sensitive or easy to fake.

The design is ready when it states the outcome, boundary, invariants, acceptance checks, slice order, risks and the decisions still owned by the owner. Hand the accepted design to the feature or fix workflow; do not implement it from this skill.

## Exit check

The design is ready when:

- the outcome and boundaries are explicit;
- each invariant has an observable acceptance check;
- each slice can be verified independently;
- the project record and current code were read where they could answer a question;
- unresolved decisions name the owner and why they cannot be settled internally.

## Red flags

- designing from memory without reading the current project;
- copying a prior implementation without checking what contract made it valid;
- one name for two concepts or two names for one concept;
- a boundary whose caller must know its internal representation;
- a default or fallback that hides an invalid state;
- a plan made of layers that cannot be verified independently;
- documenting the design's history instead of its current contract;
- starting implementation before the owner-approved outcome is clear.

## See also

- dim-station-plan
- dim-line-feat
- dim-line-fix
- dim-simplify

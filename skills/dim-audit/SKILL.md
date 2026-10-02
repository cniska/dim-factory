---
name: dim-audit
description: Audit an existing codebase across independent quality areas, one reader each, and report findings the owner turns into orders. Use for a read-only sweep of code already on the default branch.
argument-hint: "<project or path>"
---

# Audit

`dim-review` judges a change; an audit examines the project, or the scope named, as it stands. It changes nothing: not the project, not the record, not an order.

## Scope

Name the project, revision and scope. Read its rules and the docs that state the scope's behavior and boundaries, then list the source and tests it owns. Name a missing authority instead of assuming one. Leave out generated files and dependencies, and name any part that cannot be inspected. Size the scope so each reader inspects its paths in full; divide a larger audit into coherent scopes and report each separately.

## The passes

One read-only agent per area in [quality areas](references/quality-areas.md), plus one for every entry in [agent anti-patterns](references/agent-anti-patterns.md), each given the same scope and revision, the project's rules and only its own brief. A reader may search to find candidates, but judges each only after reading the surrounding implementation, callers, tests and contracts. The anti-pattern examples are from dim-factory; apply a project rule only where the audited project has adopted it, and translate each fix to that project's own files and commands. A test that must change for a behavior-preserving refactor is suspect, while a guard for a wire value, a model-facing instruction, security or storage stays.

Each reader returns source-backed findings, the paths it checked and the paths it could not judge. For a proposed test deletion, it names the failure the test can detect, the production owner, overlapping tests and the stronger proof that would remain. Recheck each candidate at its source, resolve duplicates and contradictions, and keep responsibility for the result in this session.

## Report

State the revision and scope. One row per area with `findings`, `clear`, `not_applicable` or `incomplete`, and a reason for either of the last two; the anti-pattern row accounts for every entry. A `clear` mark means the relevant paths were read, not that a search matched nothing. For each confirmed finding, give the area, file and line, the consequence, the source evidence and the fix. Say what would settle each unresolved case.

The result is for the operator to decide what work to request. A clean audit means every applicable area was read in the stated scope and no finding survived verification.

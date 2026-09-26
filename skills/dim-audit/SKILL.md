---
name: dim-audit
description: Audit an existing codebase across independent quality dimensions. Use for a read-only sweep of code already on the default branch.
argument-hint: "<project or path>"
---

# Audit

Audit existing code across independent dimensions, one reader per dimension. `dim-review` judges a change; this skill examines the declared project or area as it stands. Leave the project, its record and its orders unchanged.

## Scope

Identify the project, revision and area being inspected. Read its rules and the available docs that state the area's behavior and boundaries, then enumerate the owned source and tests. Name a missing authority instead of assuming one exists. Exclude generated files and dependencies, and name any area that cannot be inspected. Size the area so each reader can inspect its relevant paths in full; divide a larger audit by coherent area and report each area separately.

## The passes

The passes adapt the dimensions in `dim-review` to code already on the default branch. Spawn a read-only agent for each dimension when independent sessions are available. Give each the same area and revision, the project's rules and only its own brief. A reader may use searches to locate candidates, but must inspect the surrounding implementation, callers, tests and contracts before judging them. When subagents are unavailable, run the passes separately and keep their findings distinct until convergence.

| Dimension | Question to answer |
|---|---|
| Anti-patterns | Does the area contain any entry in [the anti-pattern reference](references/agent-anti-patterns.md)? Check every entry. Its dim-factory examples are candidates; apply project-specific rules only where the audited project has adopted them, and translate fix directions to that project's own files and commands. |
| Correctness | Do its entry points, state changes and failure paths fulfill the documented behavior and caller contracts? |
| Tests | Do tests fail on credible regressions in important behavior? Which tests duplicate stronger proof, assert implementation details or keep test-only production seams alive? Preserve independent contract guards before proposing deletion. |
| Architecture | Do responsibilities, dependencies and extension points follow the project's stated boundaries? Does an abstraction carry a policy or invariant? |
| Maintainability | Do names, control flow and local patterns leave a concrete cost to understanding or change? Ground convention findings in the project's rules or neighboring code. |
| Docs | Do the area's pages describe its current behavior, commands and vocabulary? Cite the implementation behind a claim of drift. |
| Security | Can a concrete path cross a trust boundary, expose sensitive data or execute unsafe input? |
| Performance | When the area's stated behavior or observed use identifies a sensitive path, does it repeat work, grow without a bound or misuse resources? |

Each reader returns source-backed findings, areas checked and areas it could not judge. Recheck candidate findings at their source, resolve duplicates and contradictions, and keep responsibility for the final result in this session.

## Report

State the project revision and inspected scope. Show one summary row per dimension with `findings`, `clear`, `not_applicable` or `incomplete`, and a reason for either of the latter two. Within the anti-pattern pass, account for every entry in the reference. A `clear` mark requires inspection of the relevant paths, not just a text search. For each confirmed finding, give the dimension, exact file and line, concrete consequence, source evidence and fix direction. Say what would settle each unresolved case.

The result is for the operator to decide what work to request. Do not edit code, create orders, or turn one finding into an assumed order. A clean audit means every applicable dimension was checked in the stated scope and no finding survived verification.

## Red flags

- treating a regex match or a broad style preference as a confirmed finding
- marking a dimension clear after inspecting only a sample
- reporting a problem without its consequence and source evidence
- editing the project or creating an order during discovery
- hiding an uninspected area behind a clean verdict

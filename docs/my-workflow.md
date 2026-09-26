# My workflow

How I build software with coding agents by hand — the workflow the factory replaces. It is the factory's yardstick: each step either has a station or gate that does it, or it is a gap. [`factory.md`](factory.md) says how the factory works.

Sources: my [My Workflow](https://gist.github.com/cniska/e3081dc2b47de82fe2ae04f5af3a2237) gist, what I said on 2026-09-20 (Codex session `01a0b967`), and what the record shows ([`findings.md`](findings.md), "The workflow the factory copies was never written down").

```text
design → build → review → ship
```

I route work by capability: a powerful model for hard design and high-risk review, a balanced one to drive and implement, a fast one for bounded edits. The factory holds the same split as tiers per role ([`src/routing.ts`](../src/routing.ts)).

## The steps

### 1. Scope against what was already done

Before deciding anything, ask the record: where this shape already exists (`dim q prior-art`), what was settled before (`dim q search`), and whether this continues earlier work (`dim q resume`, `dim q chain`).

- **Check:** nothing is re-derived that the record already holds.
- **Factory:** the planner's brief (`dim-station-plan`).

### 2. Design with a second model

A powerful model produces the design directly, with no separate planning step, and a different model argues it in rounds. Each claim the second model makes is checked at its source before it is taken, in both directions. Where a project keeps a `SPEC.md`, the spec is updated before the change is implemented.

- **Check:** the design survived an independent reading, and no claim in it is unverified.
- **Factory:** the planner, at the `deep` tier. A second model arguing the plan is a gap.

### 3. Review the contracts before building

Types, schemas, states, errors and function layout are settled before code is written. When I reviewed a whole Acolyte codebase weeks into the project, I found heuristics and text parsing where structured contracts belonged, and untangling it took days, module by module.

- **Check:** every boundary has a stated contract, and nothing is inferred from prose.
- **Factory:** I approve the plan (`dim order approve`). A contract review before build is a gap.

### 4. Build in slices

One slice at a time, each verified and committed on its own. Features go in dependency order: the contract and data model, then schema and lifecycle, then the service path, then jobs or agents, then the consumer surface. Every slice runs the loop: edit, the repo's check, simplify, the check again, a read-only checking agent, an answer to every finding, commit. Simplifying is in the loop because agents overengineer, and maintainability is where agent-built code fails first.

- **Check:** each slice is green on the repo's own check, and the model has exercised the change itself rather than handing me something only I can confirm. Every finding is fixed or refused with a reason.
- **Factory:** the builder runs this loop (`dim-station-build`), and the runner checks each turn in the check sandbox, applies the comment gate and commits it. The model exercising the product itself is a gap.

### 5. Review by dimension

The finished work is reviewed one agent per dimension — correctness, tests, architecture, maintainability, docs, security, style — so no reader carries every checklist at once. Findings go back until each is answered. High-risk changes also get my own read.

- **Check:** no finding is left unanswered.
- **Factory:** the reviewer and its report (`dim-station-review`), and my approval of the Review artifact.

### 6. Hand off

When context runs long, the session writes a handoff and the next one starts clean from its `## Next`. It is the step I run most.

- **Check:** the next session starts from committed state and a stated next move.
- **Factory:** the order record and resumed worker sessions replace the handoff; `dim wake` delivers the Next when I resume.

### 7. Ship

Verified slices are committed locally; a shared branch is pushed only on my go.

- **Check:** the work is on the trunk.
- **Factory:** `dim order ship`.

### 8. Close the gap

The same friction met twice becomes a skill, a sharper repository rule, or a gate, so the workflow tightens instead of depending on memory.

- **Check:** the friction does not come back.
- **Factory:** `q repeats` and `q findings` name the candidates ([`goals.md`](goals.md)); turning one into a gate is still done by hand.

## Where my attention goes

Reading every diff does not scale, so the factory puts my attention on what does:

- **The plan**, before anything is built.
- **The Build artifact**, an explanation of what was built, read in place of the diff.
- **The Review artifact**, before the work ships.

## Not yet in the factory

- A reviewed Build artifact per slice, so review debt never piles up into a module-by-module audit.
- A second model arguing the plan.
- A contract review before build.
- The model exercising the product itself before handing it over.
- Scheduled reviews of whole projects — tests, architecture, docs, security — whose findings become ordinary orders.

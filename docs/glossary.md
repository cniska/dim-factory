# Glossary

The words this repo uses for the factory and its record. One word per thing, defined once: the page that argues for a thing links here rather than defining it again.

## The factory

| Term | Definition |
|---|---|
| Line | Which kind of work an order is: `feat` for work that adds, `fix` for work that repairs. `dim-line-feat` and `dim-line-fix` are the entry points onto the factory line |
| Station | A skill that does one repeatable operation, with an entry contract and an exit check — `dim-station-plan`, `dim-station-build`, `dim-station-review` |
| Order | One piece of work: an id, a title, the words it is stated in, a priority, a hold where the owner keeps it, and a status. It is written down before anyone takes it, and a worker taking it fills in the run and the agent, works it in one worktree, and records what it produced and how it ended. Work taken again is the same order claimed again |
| Worker | A hand the factory issues before any work starts, named `copper-7` and carrying the role it was called in as. Every moment on an order names one, written when the moment is written; several run at once, each in its own worktree, and a card names the worker its order is recorded against. What a harness calls its own agent is a later-learned attribute of the worker and never of a moment |
| Worker tree | The parent-child record of delegation: the operator owns the project run, a station worker owns its internal fan-out, and each child worker has its own identity and capabilities |
| Role | What a hand is called in as, fixed when it is issued and never read off where its work sits ([`src/roles.ts`](../src/roles.ts)): `operator`, `planner`, `builder`, `reviewer`. One exists where the record must tell one hand from another or a gate must refuse that hand something, so a kind of agent the factory does not spawn writes no rows and is not a role. Every worker carries one, which is what lets a card draw it and the router answer for it |
| Read-only role | A role that may not change the tree it reads — `planner` and `reviewer`. The axis is independent of identity: every hand writes its own rows, and these two write them about code they did not touch. A planner that edits has silently done the build, and a reviewer that edits answers a finding by overwriting the work it was sent to read |
| Reviewer | The hand that reads a slice against a fixed brief and writes the findings it raises, under its own name. It is spawned by `dim`, never by the builder whose work it reads, because a finding a builder typed cannot be told from one it invented |
| Stage | How far along the line an order has got: `todo` before it starts, `active` while it runs, `done` once it stopped. The manufacturing split between material waiting, material in process and material finished. Not a station, which says which operation the work is at rather than how far it has got |
| Status | The state an order is in: `queued`, `working`, `completed` or `dropped`. Work that stopped without landing goes back to `queued`, carrying why, because it is work nobody is holding; a drop is terminal instead, since deciding not to build something is not an attempt that failed |
| Slice | One increment inside an order: a change that verifies on its own and is committed on its own |
| Operator | What reads a queue, delegates each station, and checks the returned outcome against the order before advancing it. It decides which work starts and when to stop, never how the work is done |
| Operator decision | A higher-level phase decision: whether the station returned enough evidence to advance, whether work returns for another attempt, or whether the order is held. It coordinates station outcomes without duplicating the station's technical review |
| Owner | The person the floor runs for. They decide what a hold is released for and read the run on the wall; how the factory itself is built and run is the operator's, and the wall is the one surface designed to the owner's needs |
| Queue | The orders nobody holds, in the order they are taken: most urgent first, then oldest. Read and never inferred |
| Hold | A boundary a run stops at rather than crossing alone: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session. An order carries one as the reason the owner has to release it before anyone takes it |
| Workspace command | A command a repo declares in its manifest — a `package.json` script, a `mise` task, a `Makefile` target — read and never inferred, carrying the name it answers to and the file it was read from ([`src/workspace-commands.ts`](../src/workspace-commands.ts)). The check is the one that stands for "this change is sound", and `dim check-command` prints it |

## The record

| Term | Definition |
|---|---|
| Claim | The moment a worker takes a queued order, recording the run, the worker and the station, and making the worktree the order is worked in. It is also the start, because the order already existed |
| Drop | The owner's decision not to build a queued order, carrying the reason — `dim order drop <order-id> --reason "..."`. A status rather than a delete, so why it was not built stays on the row; refused once a claim has copied the order's words into the record, the same boundary `dim order amend` is refused past |
| Ship | Landing a working order's own commits on the repo's trunk without rewriting them — `dim order ship`, under the factory lock. What it means differs per repo: this one merges locally, another opens a pull request; a repo that landed is the only fact `dim order stop <order> completed` reads, not whether `ship` ran |
| Evidence | What an order produced, recorded as it happens: commits, changed files, checks and their exit status, findings and how each was answered, and the documents it updated |
| Artifact | A document a station wrote for a reader — a plan, an account — held as rows with an identity of its own, a version linking to the one it replaces, the hand that wrote it and, where it is approved, the separate hand that approved it. Never a file in the worktree: a path is not an identity, a file cannot say who wrote it or whether it moved after approval, and one committed alongside the work becomes part of the diff it describes |
| Finding | Something a checking agent raised on a slice, ending either fixed or refused with the grounds the refusal rested on |
| Done | An order whose check passed on its final commit, whose findings were all answered, whose docs changed with the behavior, whose commits are on the trunk, and whose worktree is gone |
| Gate | A rule git or `dim` refuses to let pass, holding whether or not anything was read — a commit subject's shape, a schema version, an order completing unchecked or unlanded |
| Tier | The capability a role's work needs — `cheap`, `standard` or `deep` — declared per role and mapped to this harness's models in one machine-level file |
| Capability | What a station's work needs, named for the work and never for a harness's flag — `read-files`, `edit-files`, `read-history`, `ask-dim`, `raise-finding`, `run-check` — a closed vocabulary a station's set is checked against, the same way a role is checked against [`src/roles.ts`](../src/roles.ts) ([`src/capabilities.ts`](../src/capabilities.ts)) |
| Spawn profile | One file per machine, beside `routing.json`, turning a capability set and a tier's model into one harness's argv: an argv template, a slot per shape of flag the harness exposes, and a map from capability to the values each grants a slot ([`src/spawn-profile.ts`](../src/spawn-profile.ts)) |

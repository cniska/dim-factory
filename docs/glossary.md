# Glossary

The words this repo uses for the factory and its record. One word per thing, defined once: the page that argues for a thing links here rather than defining it again.

## The factory

| Term | Definition |
|---|---|
| Line | Which kind of work an order is: `feat` for work that adds, `fix` for work that repairs. `dim-line-feat` and `dim-line-fix` are the entry points onto the factory line |
| Station | A skill that does one repeatable operation, with an entry contract and an exit check — `dim-station-plan`, `dim-station-build`, `dim-station-review` |
| Order | One piece of work: an id, a title, the words it is stated in, a priority, a hold where the owner keeps it, and a status. It is written down before anyone takes it, and a worker taking it fills in the run and the agent, works it in one worktree, and records what it produced and how it ended. Work taken again is the same order claimed again |
| Worker | The agent holding an order. Several run at once, each in its own worktree, and a card names the worker its order is recorded against |
| Stage | How far along the line an order has got: `todo` before it starts, `active` while it runs, `done` once it stopped. The manufacturing split between material waiting, material in process and material finished. Not a station, which says which operation the work is at rather than how far it has got |
| Status | The state an order is in: `queued`, `working`, `completed`. Work that stopped without landing goes back to `queued`, carrying why, because it is work nobody is holding |
| Slice | One increment inside an order: a change that verifies on its own and is committed on its own |
| Operator | What reads a queue, claims an order, hands it to a worker and integrates what comes back. It decides which work starts and when to stop, never how the work is done |
| Owner | The person the floor runs for. They decide what a hold is released for and read the run on the wall; how the factory itself is built and run is the operator's, and the wall is the one surface designed to the owner's needs |
| Queue | The orders nobody holds, in the order they are taken: most urgent first, then oldest. Read and never inferred |
| Hold | A boundary a run stops at rather than crossing alone: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session. An order carries one as the reason the owner has to release it before anyone takes it |
| Worker | A hand the factory issues before any work starts, named `copper-7`, carrying the role it was called in as. Every moment on an order names one, written when the moment is written; what a harness calls its own agent is a later-learned attribute of the worker and never of a moment |
| Workspace command | A command a repo declares in its manifest — a `package.json` script, a `mise` task, a `Makefile` target — read and never inferred, carrying the name it answers to and the file it was read from ([`src/workspace-commands.ts`](../src/workspace-commands.ts)). The check is the one that stands for "this change is sound", and `dim check-command` prints it |

## The record

| Term | Definition |
|---|---|
| Claim | The moment a worker takes a queued order, recording the run, the worker and the station. It is also the start, because the order already existed |
| Evidence | What an order produced, recorded as it happens: commits, changed files, checks and their exit status, findings and how each was answered, and the documents it updated |
| Finding | Something a checking agent raised on a slice, ending either fixed or refused with the grounds the refusal rested on |
| Done | An order whose check passed on its final commit, whose findings were all answered, whose docs changed with the behavior, whose commits are on the trunk, and whose worktree is gone |
| Gate | A rule git or `dim` refuses to let pass, holding whether or not anything was read — a commit subject's shape, a schema version, an order completing unchecked or unlanded |
| Tier | The capability a role's work needs — `cheap`, `standard` or `deep` — declared per role and mapped to this harness's models in one machine-level file |

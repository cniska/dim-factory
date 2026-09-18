# Glossary

The words this repo uses for the factory and its record. One word per thing, defined once: the page that argues for a thing links here rather than defining it again.

## The factory

| Term | Definition |
|---|---|
| Line | Which kind of work an order is: `feat` for work that adds, `fix` for work that repairs. `dim-line-feat` and `dim-line-fix` are the entry points onto the factory line |
| Station | A skill that does one repeatable operation, with an entry contract and an exit check — `dim-station-plan`, `dim-station-build`, `dim-station-review` |
| Item | What the queue wants made: an id, a title, the words it is stated in, its dependencies and its status |
| Order | The order to make one item — issued to one worker, worked in one worktree, carrying what it produced and how it ended. An item taken again is a second order for the same item. Not a task, which in this codebase is a command a repo declares ([`src/tasks.ts`](../src/tasks.ts)) |
| Worker | The agent holding an order. Several run at once, each in its own worktree, and a card names the worker its order is recorded against |
| Phase | How far along an order is, as the wall groups it: `todo` before it starts, `active` while it runs, `done` once it stopped. Not a station, which says where the work is rather than how far it has got |
| Slice | One increment inside an order: a change that verifies on its own and is committed on its own |
| Driver | What reads a queue, claims an order, hands it to a worker and integrates what comes back. It decides which work starts and when to stop, never how the work is done |
| Queue | Where items wait, read and never inferred. A file-backed planner holds each item's id, title, description, dependencies and status; a tracker can serve the same purpose |
| Fence | A boundary a run stops at rather than crossing alone: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session |

## The record

| Term | Definition |
|---|---|
| Claim | The moment an order is issued, recording the item, its words, the line, the worker and the worktree before any work starts |
| Evidence | What an order produced, recorded as it happens: commits, changed files, checks and their exit status, findings and how each was answered, and the documents it updated |
| Finding | Something a checking agent raised on a slice, ending either fixed or refused with the grounds the refusal rested on |
| Done | An order whose check passed on its final commit, whose findings were all answered, whose docs changed with the behavior, whose commits are on the trunk, and whose worktree is gone |
| Gate | A rule git or `dim` refuses to let pass, holding whether or not anything was read — a commit subject's shape, a schema version, an order completing unchecked or unlanded |
| Tier | The capability a role's work needs — `cheap`, `standard` or `deep` — declared per role and mapped to this harness's models in one machine-level file |

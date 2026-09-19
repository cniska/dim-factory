# dim-factory

A local record of what every Claude Code and Codex session did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded. [`README.md`](README.md) is the tour, [`docs/build-order.md`](docs/build-order.md) says what is unbuilt and what blocks it, and each design doc under `docs/` owns its own subject. A fact lives in one of those places and is linked to from here, never copied — two authorities drift, and the one nobody remembers to update wins.

Only what holds here and nowhere else is written below. General engineering conventions belong to whoever is working, machine-wide and once; restating one here would cost the same tokens twice and create a second place for it to drift.

## Checks use model judgement, not pattern matching

- A check that needs judgement gets an agent with a fixed brief, never a regex or a word list ([`docs/findings.md`](docs/findings.md), "A word list cannot find a narrating comment").
- Express as a gate whatever is genuinely mechanical — a subject's length, a schema version, an exit code, a shape rather than a meaning. The commit hooks are the model: git refuses, and compliance does not depend on anything having been read.
- Do not reach for a heuristic where the record already answers. Which CLIs a repo is worked with and which files came back are rows to read; the workspace command a repo declares as its check is read from its manifest by [`src/workspace-commands.ts`](src/workspace-commands.ts), not inferred. [`docs/goals.md`](docs/goals.md) and [`docs/conventions.md`](docs/conventions.md) argue the general case.

## Invariants

- Nothing here reaches the network, holds a credential, or is billed per token, once the embedding model is on disk. Downloading it is the single exception and it happens once.
- A hook exits 0 whatever happens. It runs before every session, commit and push on this machine, so it may only ever fail on something it has read and understood.
- Every table is rebuilt by re-reading its sources, so a schema change is `dim rebuild`, not a migration. [`src/schema.ts`](src/schema.ts) states the rules and marks each exception.
- Every query states the base its numbers came from, and one with nothing to report says so rather than printing a zero.

## Working

- Commits go straight to `main`; no topic branch, no PR. One slice at a time: `bun run verify`, check the slice, commit, then start the next.
- Stop where the choice is the owner's: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session rather than this one.
- Measurements live in [`docs/findings.md`](docs/findings.md), dated, with what each number can carry. Write a finding when it is found — a number left in a conversation is gone when the session is, and the next agent re-measures it or assumes it.
- One word per concept, in code, docs, comments and skills alike, and [`docs/glossary.md`](docs/glossary.md) is where it is settled: read it before naming a thing, add the word there when a concept is new, and rename rather than let a second word for the same thing stand. Name the concept and never the container it currently sits in.
- A skill under `skills/` cites only queries that answer. Check what one returns before naming it.
- A comment earns its place only with a *why* a name, type or test cannot carry. Never restate the line below it, never narrate what changed, and no banner or separator comments.

# dim-factory

A local record of what every Claude Code and Codex session did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded. [`README.md`](README.md) is the tour, [`docs/build-order.md`](docs/build-order.md) says what is unbuilt and what blocks it, and each design doc under `docs/` owns its own subject. A fact lives in one of those places and is linked to from here, never copied — two authorities drift, and the one nobody remembers to update wins.

## Checks use model judgement, not pattern matching

- A check that needs judgement gets an agent with a fixed brief, never a regex or a word list. The measurement is in [`docs/findings.md`](docs/findings.md), "A word list cannot find a narrating comment": every one of the 12 lines such a list matched was correct, so the gate would have rejected only good comments.
- Express as a gate whatever is genuinely mechanical — a subject's length, a schema version, an exit code, a shape rather than a meaning. The commit hooks are the model: git refuses, and compliance does not depend on anything having been read.
- Do not reach for a heuristic where the record already answers; [`docs/goals.md`](docs/goals.md) and [`docs/conventions.md`](docs/conventions.md) argue the general case. Which CLIs a repo is worked with and which files came back are rows to read. What a repo declares as its check is read from its manifest by `src/tasks.ts`, not inferred.
- A checking agent returning nothing is the expected result, not a wasted pass — see [`docs/findings.md`](docs/findings.md), "Review already finds nothing, most of the time". A checker earns trust the way a test does: plant a defect once, watch it be caught, take it out.
- Hand a slice back to the builder while a finding is unanswered, not while findings exist. The builder either fixes a finding or records why not, which is what stops a wrong finding from becoming the standard.

## Invariants

- Nothing here reaches the network, holds a credential, or is billed per token, once the embedding model is on disk. Downloading it is the single exception and it happens once.
- A hook exits 0 whatever happens. It runs before every session, commit and push on this machine, so it may only ever fail on something it has read and understood — the subject it was handed, the check that ran, the ancestry the remote reported.
- Every table is rebuilt by re-reading its sources, so a schema change is `dim rebuild`, not a migration. The rules for `SCHEMA_VERSION`, for a table with no source to re-read, and for a derived table are stated at the top of [`src/schema.ts`](src/schema.ts) and at each table that is an exception.
- Every query states the base its numbers came from, and one with nothing to report says so rather than printing a zero.

## Workflow

- `bun run verify` — the gate, and what CI runs. `bun run format` applies biome.
- `dim sync` reads new bytes; `dim rebuild` re-reads from the start; `dim check-task` prints what this repo declares as its check.
- `bun link` puts `dim` on PATH.

## Process

- Commits go straight to `main` here; no topic branch, no PR.
- One slice at a time: `bun run verify`, check the slice, commit, then start the next. `dim q slices` reads back which commits had a check in front of them.
- Default to autonomous execution. Stop only where the choice is the owner's: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session rather than this one.
- Verify every factual claim at its source before it ships and cite it. This binds hardest on text that ships inside the product, where a plausible sentence is indistinguishable from a verified one after the fact.

## Commits

- Conventional Commits, single-line subject, no body, at most 50 characters, ASCII. The `commit-msg` hook refuses the rest; `dim check-commits <range>` judges what landed.
- Name what changed in the plainest words that identify it — nothing about why, nothing about how the work went.

## Code

- One concern per file, named for that concern. Import from the canonical source module; no re-export layers.
- Distinguish errors by a structured field, never by matching on a message string.
- Read and edit files with the file tools rather than through the shell, so a concurrent write is refused rather than silently overwritten.
- A comment earns its place only with a *why* a name, type or test cannot carry — the constraint that forced this approach, the alternative that does not work, the contract being satisfied. Never restate the line below it, never narrate what changed, and no banner or separator comments.

## Stations

- The `dim-` skills under `skills/` are the stations, and they differ from a tool-agnostic engineering skill by reading the record, so none is portable to a machine without this database. `src/skill.ts` states how one is added and removed.
- A station cites only queries that answer. Check what one returns before naming it, and read [`docs/findings.md`](docs/findings.md) for what a query is already known not to carry.

## Docs

- `README.md`, `AGENTS.md` and `docs/**` change in the same commit as the behavior they describe.
- Measurements live in [`docs/findings.md`](docs/findings.md), dated, with what each number can carry. The rules they argue for live in [`docs/design.md`](docs/design.md).
- Write a finding down when it is found, not at the end. A number measured and left in a conversation is gone when the session is, and the next agent re-measures it or, worse, assumes it.

## Testing

- Tests live in `src/` beside what they cover, named for the unit under test rather than always for a file — `src/search.test.ts` covers the `search` query inside `src/queries.ts`. The shell suite is `scripts/wt.test.sh`, which runs against `dim wt` rather than a copy of its logic.
- A test claiming an invariant must fail when the invariant is removed — delete the check, watch it go red, put it back.
- Pin wire values as literals: header names, record fields, status codes. Importing the production constant makes a rename ratify itself.

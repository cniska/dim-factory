# dim-factory

A local record of what every Claude Code and Codex session did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded. [`README.md`](README.md) is the tour, [`docs/todo.md`](docs/todo.md) says what is unbuilt, and each design doc under `docs/` owns its own subject. A fact lives in one of those places and is linked to from here, never copied — two authorities drift, and the one nobody remembers to update wins.

Only what holds here and nowhere else is written below. General engineering conventions belong to whoever is working, machine-wide and once; restating one here would cost the same tokens twice and create a second place for it to drift.

## Checks use model judgement, not pattern matching

- A check that needs judgement gets an agent with a fixed brief, never a regex or a word list ([`docs/findings.md`](docs/findings.md), "A word list cannot find a narrating comment").
- Express as a gate whatever is genuinely mechanical — a subject's length, a schema version, an exit code, a shape rather than a meaning. The commit hooks are the model: git refuses, and compliance does not depend on anything having been read.
- Do not reach for a heuristic where the record already answers. Which CLIs a repo is worked with and which files came back are rows to read; the workspace task a repo declares as its check is read from its manifest by [`src/workspace-tasks.ts`](src/workspace-tasks.ts), not inferred.

## Invariants

- Nothing here reaches the network, holds a credential, or is billed per token, once the embedding model is on disk. Downloading it is the single exception and it happens once.
- A hook exits 0 whatever happens. It runs before every session, commit and push on this machine, so it may only ever fail on something it has read and understood.
- Every table is rebuilt by re-reading its sources, so a schema change is `dim rebuild`, not a migration, and it stops the floor: from the version bump until the rebuild runs, every `dim` write on this machine is refused, so an order changing the schema runs with no other order in flight. [`docs/design.md`](docs/design.md#schema) states the rules, and each exception says so at its table.
- Every query states the base its numbers came from, and one with nothing to report says so rather than printing a zero.

## Working

- Commits go straight to `main`; no topic branch, no PR. A builder works in the order's own worktree, made by its claim, and lands it with `dim order ship` — [`docs/factory.md`](docs/factory.md#done) says when that worktree is removed. One slice at a time: check the slice, commit, then start the next. The commit gate runs `bun run verify` and refuses on a failure, so run it by hand only to read a failure you are working through, never to confirm what the gate is about to confirm.
- Stop where the choice is the owner's: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session rather than this one. How the factory itself is built and run is not one of them — it is the machinery you work in, so settle its shape and say what you settled. The wall is the exception, being the surface the owner reads the floor on, and its design answers to them.
- Measurements live in [`docs/findings.md`](docs/findings.md), dated, with what each number can carry. Write a finding when it is found — a number left in a conversation is gone when the session is, and the next agent re-measures it or assumes it.
- One word per concept, in code, docs, comments and skills alike, and [`docs/glossary.md`](docs/glossary.md) is where it is settled: read it before naming a thing, add the word there when a concept is new, and rename rather than let a second word for the same thing stand. Name the concept and never the container it currently sits in.
- A skill under `skills/` cites only queries that answer. Check what one returns before naming it.
- Code here carries no comments, tool contracts aside. The comment gate ([`docs/usage.md`](docs/usage.md#install-the-shared-controls)) holds it for new and changed JS and TS lines, and the runner holds it for a factory builder's commit, reading the ban from `.dim/config.json` as the trunk commits it, so a builder cannot lift it from its worktree. A why goes into a name, a test that holds it, or the doc that owns the subject.

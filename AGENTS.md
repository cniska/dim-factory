# dim-factory

A local record of what every coding-agent session on this machine did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded. [`SPEC.md`](SPEC.md) states what holds, and changes in the same commit as the behavior it states. Which sessions are read is in [`docs/design.md`](docs/design.md#sources). [`README.md`](README.md) is the tour, [`docs/todo.md`](docs/todo.md) says what is unbuilt, and each design doc under `docs/` owns its own subject. A fact lives in one of those places and is linked to from here, never copied — two authorities drift, and the one nobody remembers to update wins.

Only what holds here and nowhere else is written below. General engineering conventions belong to whoever is working, machine-wide and once; restating one here would cost the same tokens twice and create a second place for it to drift.

## Checks use model judgement, not pattern matching

- A check that needs judgement gets an agent with a fixed brief, never a regex or a word list ([`docs/findings.md`](docs/findings.md), "A word list cannot find a narrating comment").
- Express as a gate whatever is genuinely mechanical — a subject's length, a schema version, an exit code, a shape rather than a meaning. The commit hooks are the model: git refuses, and compliance does not depend on anything having been read.
- Do not reach for a heuristic where the record already answers. Which CLIs a repo is worked with and which files came back are rows to read; the workspace task a repo declares as its check is read from its manifest by [`src/workspace-tasks.ts`](src/workspace-tasks.ts), not inferred.

## Invariants

- A hook runs before every session, commit and push on this machine, so it holds [`SPEC.md`](SPEC.md) NF-1 and NF-2 in every change.
- An order that changes the schema runs with no other order in flight ([`docs/design.md`](docs/design.md#schema)).

## Working

- Run `bun run verify` by hand only to read a failure you are working through. The commit gate runs it and refuses on a failure ([`docs/usage.md`](docs/usage.md#commit-gate)).
- How the factory itself is built and run is settled in the work. The wall is the exception, and its design answers to the owner.
- Write a measurement into [`docs/findings.md`](docs/findings.md) when it is found. A number left in a conversation is gone when the session is.
- One word per concept, in code, docs, comments and skills alike, and [`docs/glossary.md`](docs/glossary.md) is where it is settled: read it before naming a thing, add the word there when a concept is new, and rename rather than let a second word for the same thing stand. Name the concept and never the container it currently sits in.
- A skill under `skills/` cites only queries that answer. Check what one returns before naming it.
- Code here carries no comments, tool contracts aside. A why goes into a name, a test that holds it, or the doc that owns the subject. The comment gate holds it ([`docs/usage.md`](docs/usage.md#comment-gate)).

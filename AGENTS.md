# dim-factory

A software factory run by coding agents, with the owner at the gates that still earn one. The local record of every session is how it measures itself. [`docs/README.md`](docs/README.md) indexes the docs.

## Rules

- [`SPEC.md`](SPEC.md) holds the requirements, so a changed requirement shows as a change to that one file. Update it in the same commit as the behavior. Only `docs/README.md` links it; no other doc, commit or code names it or its IDs. An acceptance test's name starts with the criteria it proves, which a check ties to the spec both ways, so IDs may be renumbered in the commit that updates the tests.
- Fix the cause, never work around it, and add no debt. Debt you find is fixed where it is found, or written into [`docs/todo.md`](docs/todo.md) when it needs work of its own.
- A check that needs judgement gets an agent with a fixed brief, never a regex or a word list. What is mechanical is a gate.
- Read what the record already answers instead of inferring it. A repo's check is the task its manifest declares ([`src/declared-tasks.ts`](src/declared-tasks.ts)).
- An order that changes the schema runs with no other order in flight ([`docs/core.md`](docs/core.md#record-versions)).
- The commit gate runs `bun run check`. Run it by hand only to read a failure. CI also runs the acceptance suite, `bun run test:acceptance`, which drives `dim` end to end on macOS.
- A change to how `dim` behaves is seen working through [`dim-verify`](.agents/skills/dim-verify/SKILL.md) before it lands.
- Cloud work runs on a branch and lands on `main` by fast-forward, `git push origin HEAD:main`, once `bun run check` passes. Never force it.
- How the factory is built and run is settled in the work. The wall's design answers to the owner.
- One word per concept, settled in [`docs/glossary.md`](docs/glossary.md). Read it before naming a thing, add a new word there, and rename rather than keep a synonym.
- Instructions under `prompts/` and `skills/` follow the layout in [`docs/core.md`](docs/core.md#instructions) and cite only queries whose output you checked.
- Code carries no comments, tool contracts aside. A why goes into a name, a test, or the doc that owns the subject.

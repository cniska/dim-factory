# Todo

What is not built, highest priority first. An entry is here only for a need this repo has now, and it is fixed at its cause, sized to the problem.

## Bugs

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **Worker subagents never reach the record** — only the main transcript is copied to `workers/<name>/sessions/` (`station-effects.ts` `copySession`), so what a worker's subagents read or load is not queryable. Copy the subagent transcripts and read them as `<agent id>@<parent>` sessions.
- **Install a project's gates when dim adopts it** — built when dim adopts hoodly, not before. `dim` brings the machinery that writes a project's gates into the project, where every contributor runs them, copied from dim-factory's own: `.githooks` set through `prepare`, its commit-subject script, the no-comments test, a CI commits job, and a report of a project whose copy differs from the canonical one.
- **The module checks read imports with a parser** — `src/factory-modules.test.ts` `importsOf` takes value imports from `Bun.Transpiler.scanImports`, which drops `import type`, so type-only imports come from a regex a reformatted import slips past; `sqlBreaches` and `coded-error.test.ts` `errorBreaches` match text, strings included. The installed TypeScript 7 has no stable parser API. Take the import graph from the compiler or the linter.
- **Codex trust is read by key, not hash** — `hooks-codex-trust.ts` counts a hook trusted when its positional key has any hash, so a hook moved onto another's key reads trusted until Codex asks again. Compare the hash once Codex's algorithm is known.
- **Type assertions in `src/`** — Biome's `noUnsafeTypeAssertion` flags casts across `src/`, most in the ingest parsers, which read Claude, Codex and git output without a schema. Parse each at its boundary and turn the rule on for `src/`, as `acceptance/` has it.
- **Tests without proof or duplicates** — the trace permission tests prove nothing as root; spies in `db.test.ts` test calls, not outcomes; `ingest-tools.test.ts` asserts schema text.

## Features

- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized, so fix orders run unattended.
- **Ship through a pull request** — since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).

## Owner decides

- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Does an unattended run push, or commit locally?
- Does the wall become where the owner reads artifacts and approves, rather than only watches?
- Is `dim` for one owner, or for teams with several?
- Repo identity is `project`, `repo` and `label`, sometimes a path and sometimes owner/repo. "Finding" names review findings and checking-agent findings; the glossary lacks repo, checkout, round and brief. Which words?

## Waiting on data

- Whether any unmarked or v1 spool hook is still installed, so `hooks.ts` `hookKind` can drop the retired shapes it recognises only to replace them.
- Whether Codex records a typed prompt as an event, so `ingest-parse-codex.ts` can drop its prompt-source regex.

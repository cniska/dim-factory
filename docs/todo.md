# Todo

What is not built, highest priority first. An entry is here only for a need this repo has now, and it is fixed at its cause, sized to the problem.

## Bugs

- **A plugin skill loads under two names** — a `Skill` call names it `dim:dim-plan`, while a typed `/dim:dim-plan`, which `COMMAND_NAME` rejects for its colon, takes `dim-plan` from its body path, so `skill_load` records one skill under two names. `ingest-skill-load.ts` `COMMAND_NAME`, `ingest-parse-claude.ts`. Read the plugin name from the typed command.
- **A random-kill seed fails intermittently in the full suite** — one AC-54 seed (20260932) failed once in a full parallel `test:acceptance` run and passed alone three times and in the next full run. `acceptance/reliability.acceptance.ts`. Capture a failing run's trace and fix what the kill exposes.
- **Worker sessions never reach the record** — the copy of each worker's transcript in `workers/<name>/sessions/` is read only by `dim session show`; ingestion reads `~/.claude/projects` alone, so no skill load or file read by a worker is queryable and no skill's effect on workers is measurable. `ingest-claude-source.ts` `listClaudeTranscripts`, `paths.ts` `workerSessionsDir`. Ingest the worker copies as sessions.

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **Install a project's gates when dim adopts it** — built when dim adopts hoodly, not before. `dim` brings the machinery that writes a project's gates into the project, where every contributor runs them, copied from dim-factory's own: `.githooks` set through `prepare`, its commit-subject script, the no-comments test, a CI commits job, and a report of a project whose copy differs from the canonical one.
- **The module checks read imports with a parser** — `src/factory-modules.test.ts` `importsOf` takes value imports from `Bun.Transpiler.scanImports`, which drops `import type`, so type-only imports come from a regex a reformatted import slips past; `sqlBreaches` and `coded-error.test.ts` `errorBreaches` match text, strings included. The installed TypeScript 7 has no stable parser API. Take the import graph from the compiler or the linter.
- **Codex trust is read by key, not hash** — `hooks-codex-trust.ts` counts a hook trusted when its positional key has any hash, so a hook moved onto another's key reads trusted until Codex asks again. Compare the hash once Codex's algorithm is known.
- **Declared commands run the operator's toolchain** — the check and the install run whatever `bun`, `node` or `pnpm` the operator's `PATH` resolves, not the version the project pins in `mise.toml`, so a project pinned to one Bun is checked under another; a commit hook that runs `bun run verify` does the same. `check-effects.ts` `runSandboxed`. Run them under the project's pinned toolchain.
- **Type assertions in `src/`** — Biome's `noUnsafeTypeAssertion` flags casts across `src/`, most in the ingest parsers, which read Claude, Codex and git output without a schema. Parse each at its boundary and turn the rule on for `src/`, as `acceptance/` has it.
- **Comments in generated files** — `wall/styles.css` and the generated hooks carry rationale comments, against the ban.
- **Tests without proof or duplicates** — the trace permission tests prove nothing as root; the lock tests in `ingest-launchd.test.ts` repeat `db-lock.test.ts`; spies in `db.test.ts` test calls, not outcomes; `ingest-tools.test.ts` asserts schema text.

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

# Todo

What is not built, highest priority first. An entry is here only for a need this repo has now, and it is fixed at its cause, sized to the problem.

## Bugs

- **A plugin skill loads under two names** — a `Skill` call names it `dim:dim-plan`, while a typed `/dim:dim-plan`, which `COMMAND_NAME` rejects for its colon, takes `dim-plan` from its body path, so `skill_load` records one skill under two names. `ingest-skill-load.ts` `COMMAND_NAME`, `ingest-parse-claude.ts`. Read the plugin name from the typed command.
- **Hook payloads are stored verbatim** — every PostToolUse stdin, with file contents, command output and edits, goes into `hook_event.payload`, which nothing reads, against [`design.md`](design.md) "Never stored". `ingest-spool.ts` `drainSpool`, `db-schema.ts` `hook_event`, `ingest-sync.ts`. Keep the parsed fields; drop the column.

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **Worker skills follow the new spec** — lands with the core rewrite, after `core.md`. `dim-feat` and `dim-fix` go, and their bug-fixing content becomes `references/bug.md` in `dim-plan`, `dim-build` and `dim-review`. One base skill every worker loads holds the conduct now spread across `dim-git`, `dim-tdd`, `dim-simplify` and `dim-artifact`, shaped after pstack's `poteto-mode` (a short core, principles read when one applies, a playbook per kind of work). The planner and builder name the data shape before logic; the operator runs an experiment rather than ask the owner what one can answer, and checks each artifact against the record rather than repeating a worker's summary.
- **The module checks read imports with a parser** — `src/factory-modules.test.ts` `importsOf` takes value imports from `Bun.Transpiler.scanImports`, which drops `import type`, so type-only imports come from a regex a reformatted import slips past; `sqlBreaches` and `throwBreaches` match text, strings included. The installed TypeScript 7 has no stable parser API. Take the import graph from the compiler or the linter.
- **One git runner, one clock** — the `git()` wrappers have several result shapes and handle failure differently at every call site. `git()` in `comments-files.ts` `git-committed.ts` `git-remote.ts` `guidance.ts` `worktree.ts`; one remote-URL parser for `git-remote.ts` `repositoryLabel` and `git-remote-slug.ts` `remoteSlug`.
- **One descriptor per harness** — adding a harness touches several files, and `hookConfigPath` and `wantedHooks` treat any unknown harness as Codex. `harness-name.ts`, `ingest-tools.ts`, `hooks.ts`, `ingest-sources.ts`, `ingest-history.ts`, `guidance-walk.ts`, `session-start-context.ts`.
- **Closed vocabularies are exhaustive at compile time** [schema] — one `as const` list per vocabulary feeds both its type and its `CHECK`: `session.tool` has none. `Tool` and `HarnessName` become one list.
- **The FTS trigger re-indexes unchanged text** [schema] — `message_fts_update` re-indexes a message whose text did not change, about five times the ingest cost, and `message.src_file` and `tool_call.src_file` cascade with no index. `db-schema.ts`. `WHEN old.text IS NOT new.text` on the trigger, and the two indexes.
- **Comments in the schema and generated files** — `db-schema.ts` carries SQL comment blocks, some stale, and `wall/styles.css` and the generated hooks carry rationale comments, against the ban. A table's reason goes into [`design.md`](design.md), and design.md stops saying it lives beside the table.
- **Tests without proof or duplicates** — the trace permission tests prove nothing as root; the lock tests in `ingest-launchd.test.ts` repeat `db-lock.test.ts`; spies in `db.test.ts` test calls, not outcomes; `ingest-tools.test.ts` asserts schema text; `src/wall/client.test.tsx` greps its own source for class strings, so it fails on a restyle and passes on a broken render.

## Features

- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized, so fix orders run unattended.
- **Ship through a pull request** — since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).

## Owner decides

- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Does an unattended run push, or commit locally?
- Does the wall become where the owner reads artifacts and approves, rather than only watches?
- Is `dim` for one owner, or for teams with several?
- Repo identity is `project`, `repo` and `label`, sometimes a path and sometimes owner/repo. "Finding" names review findings, checking-agent findings and measurements; the glossary lacks repo, checkout, round and brief. Which words?

## Waiting on data

- Whether any unmarked or v1 spool hook is still installed, so `hooks.ts` `hookKind` can drop the retired shapes it recognises only to replace them.
- Whether Codex records a typed prompt as an event, so `ingest-parse-codex.ts` can drop its prompt-source regex.

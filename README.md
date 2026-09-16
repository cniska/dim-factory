# dim-factory

Instrumentation for AI coding sessions on this machine, and the hooks that act inside them.

The name comes from [`docs/dark-factory.md`](docs/dark-factory.md): the engineering skills in `cniska/skills` form a production line — spec, plan, build, review, ship — and the question that note answers is not whether the line can run itself but at which gates removing the human costs more than it saves. Its answer is a dim factory, not a dark one: autonomous between the gates, a human at the gates that matter, and each gate earning its automation on its own merit.

Merit means evidence. This repo produces it.

## What it does

- **Collects.** Claude Code and Codex both record every session to disk. An incremental ingester reads both into one SQLite database — deterministic parsing and inserts, no model calls anywhere in the collection path.
- **Answers.** A small query CLI over that database: where loaded-skill context goes, which skills fire and by which path, where corrections cluster, what tokens and tools a session actually spends.
- **Guards.** Hooks that make mechanical what a skill can only instruct.

## Layout

| Path | Holds |
|---|---|
| [`docs/design.md`](docs/design.md) | Schema, the questions it answers, ingestion, the read path, build order |
| [`docs/evals-and-hooks.md`](docs/evals-and-hooks.md) | The hook install layout, and the eval instrument that measures whether a skill's rules earn their place |
| [`docs/dark-factory.md`](docs/dark-factory.md) | The argument this repo exists to execute |

## Constraints

- No model calls in collection or backfill. A model reads query results when asked a question, never transcripts.
- The database stores structure and a locator into the source file. Tool results, file contents and thinking stay out of it.
- Ingestion is incremental and idempotent — re-running never double-counts, and an in-progress session ingests cleanly and updates later.
- Codex has equal standing with Claude Code, not a later phase.

## Related

- `cniska/skills` — the stations this measures. It consumes the query CLI the way `pr` consumes `gh`; nothing here is installed by `npx skills add`.

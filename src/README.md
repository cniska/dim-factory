# src/

Flat, so a module is found by name. A file is named for its concern (`git-ingest.ts`, `parse-codex.ts`); a `<name>-command.ts` holds exactly the `dim` command `<name>`; a test sits beside its module as `<module>.test.ts`.

## Module groups

| Group | Files | Responsibility |
| --- | --- | --- |
| CLI | `cli.ts`, `commands.ts`, `command.ts`, `command-output.ts`, `*-command.ts` | Dispatch a command and print its result or error as one JSON line |
| Collection | `claude-source.ts`, `codex-source.ts`, `parse-*.ts`, `ingest.ts`, `sync.ts`, `spool.ts` | Read session sources and hook events into the database |
| Database | `db.ts`, `read-db.ts`, `schema.ts`, `session-records.ts`, `lock.ts` | Open, rebuild and write the SQLite store |
| Queries and retrieval | `queries.ts`, `*-queries.ts`, `row-cap.ts`, `distilled.ts`, `embed*.ts`, `bench*.ts`, `rank-metrics.ts` | Answer named questions and search the record |
| Session context | `handoff.ts`, `wake.ts`, `guidance.ts`, `skill-load.ts` | Carry context into the next session |
| Factory orders | `factory-order-*.ts`, `order-*.ts`, `factory-queries.ts`, `factory-stop.ts` | Orders, their lifecycle, stations and evidence |
| Workers and harnesses | `harness*.ts`, `*-harness.ts`, `worker-*.ts`, `routing.ts`, `roles.ts`, `capabilities.ts` | Start station workers under Claude Code or Codex, and who they are |
| Build and ship | `builder-commit.ts`, `sandboxed-check.ts`, `rebase-turn.ts`, `ship*.ts`, `trunk.ts` | Commit a builder's turn, check it, and land it |
| Wall | `factory-wall.ts`, `wall-*.ts`, `wall-client.tsx`, `wall.html`, `wall.css`, `components/`, `lib/` | The read-only board |
| Gates and installation | `commit-gate.ts`, `push-gate.ts`, `comments-*.ts`, `hooks.ts`, `rules.ts`, `codex-trust.ts`, `installed-skills.ts` | Install and enforce the shared controls |
| Repositories and worktrees | `worktree.ts`, `checkout.ts`, `git-*.ts`, `repo-*.ts`, `remote-slug.ts`, `workspace*.ts` | Identify repositories, read what they declare, and manage worktrees |
| Config | `config.ts`, `jsonc*.ts` | Read settings and edit tools' JSONC configs |

## Where to start

- `commands.ts` lists the commands; `command.ts` is what one is.
- `schema.ts` holds every table and the reason for its shape.
- `queries.ts` lists the named queries.
- `factory-order-lifecycle.ts`, `factory-order-ledger.ts` and `factory-order-status.ts` hold what an order is and how it moves.
- Read a module's `.test.ts` before changing its contract.

# src/

The source directory is flat so an agent can find a module by name without navigating a directory tree.

## Naming

Files use a domain-concern name where the boundary is useful: `factory-order.ts`, `git-ingest.ts`, `repo-check.ts` and `parse-codex.ts`. Tests sit beside the module they exercise as `<module>.test.ts`.

## Module groups

| Group | Files | Responsibility |
| --- | --- | --- |
| CLI and commands | `cli.ts`, `workspace-commands.ts`, `wt-command.ts` | Parse commands and connect them to operations |
| Collection | `claude-source.ts`, `codex-source.ts`, `parse-*.ts`, `ingest.ts`, `sync.ts` | Read session sources and persist normalized records |
| Database | `db.ts`, `schema.ts`, `rebuild.ts`, `read-db.ts`, `session-records.ts` | Open, rebuild and write the SQLite store |
| Retrieval | `distilled.ts`, `embed*.ts`, `queries.ts`, `render.ts`, `rank-metrics.ts` | Distill, index, query and render the record |
| Factory | `factory-order.ts`, `queue-planner.ts`, `queries.ts` | Plan file-backed work separately from persisted order lifecycle and evidence |
| Session context | `handoff.ts`, `wake.ts`, `guidance.ts`, `skill-load.ts` | Persist strict handoffs and carry context into a later session |
| Gates and installation | `commit-gate.ts`, `push-gate.ts`, `codex-trust.ts`, `hooks.ts`, `rules.ts`, `installed-skills.ts` | Install and enforce shared controls |
| Tool configs | `jsonc.ts`, `jsonc-file.ts` | Edit the JSONC a tool's config is written in, text apart from the file holding it |
| Work and repositories | `worktree.ts`, `checkout.ts`, `git-*.ts`, `repo-*.ts`, `remote-slug.ts` | Identify repositories and manage isolated work |

The CLI is the wiring boundary. Domain modules own the behavior that tests exercise; hooks and commands adapt external payloads and process arguments to those modules.

## Where to start

- Read `cli.ts` to find command wiring.
- Read `schema.ts` and `session-records.ts` to understand persisted data.
- Read `queries.ts` and `render.ts` to understand the read path.
- Read `factory-order.ts` and the factory query in `queries.ts` for factory reports.
- Read `queue-planner.ts` for the versioned queue format, dependency readiness and status transitions.
- Read the matching `.test.ts` before changing a module contract.

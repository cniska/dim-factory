# src/

The source directory is flat so an agent can find a module by name without navigating a directory tree.

## Naming

Files use a domain-concern name where the boundary is useful: `factory-order-lifecycle.ts`, `git-ingest.ts`, `repo-check.ts` and `parse-codex.ts`. A `<name>-command.ts` holds exactly the one `dim` command called `<name>`, and nothing else takes that suffix. Tests sit beside the module they exercise as `<module>.test.ts`.

## Module groups

| Group | Files | Responsibility |
| --- | --- | --- |
| CLI and commands | `cli.ts`, `commands.ts`, `command.ts`, `command-output.ts`, `*-command.ts` | Dispatch a command, run it, and print its result or error as one JSON line |
| Collection | `claude-source.ts`, `codex-source.ts`, `parse-*.ts`, `ingest.ts`, `sync.ts` | Read session sources and persist normalized records |
| Database | `db.ts`, `schema.ts`, `read-db.ts`, `session-records.ts` | Open, rebuild and write the SQLite store |
| Retrieval | `distilled.ts`, `embed*.ts`, `queries.ts`, `*-queries.ts`, `row-cap.ts`, `rank-metrics.ts` | Distill, index, query and cap the record |
| Factory | `factory-order-*.ts`, `order-ready.ts`, `factory-queries.ts` | One row per piece of work, waiting or worked, and the evidence of what it produced |
| Session context | `handoff.ts`, `wake.ts`, `guidance.ts`, `skill-load.ts` | Persist strict handoffs and carry context into a later session |
| Gates and installation | `commit-gate.ts`, `push-gate.ts`, `codex-trust.ts`, `hooks.ts`, `rules.ts`, `installed-skills.ts` | Install and enforce shared controls |
| Tool configs | `jsonc.ts`, `jsonc-file.ts` | Edit the JSONC a tool's config is written in, text apart from the file holding it |
| Work and repositories | `worktree.ts`, `checkout.ts`, `git-*.ts`, `repo-*.ts`, `remote-slug.ts` | Identify repositories and manage isolated work |

The CLI is the wiring boundary. Domain modules own the behavior that tests exercise; hooks and commands adapt external payloads and process arguments to those modules.

## Where to start

- Read `commands.ts` for the list of commands and `command.ts` for what one is.
- Read `schema.ts` and `session-records.ts` to understand persisted data.
- Read `queries.ts` and the `*-queries.ts` it lists to understand the read path.
- Read `factory-queries.ts` for factory reports.
- Read `order-ready.ts` for the order waiting work comes back in, `factory-order-lifecycle.ts` for what a claim holds, `factory-stop.ts` for a stop, and `factory-order-status.ts` for the completion gate.
- Read the matching `.test.ts` before changing a module contract.

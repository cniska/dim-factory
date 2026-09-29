# src/

Flat, so a module is found by name. A file's prefix is its module: `db-read.ts` belongs to `db`, `order-ship.ts` to `order`. A module that is one file carries its bare name (`doctor.ts`, `paths.ts`). Commands are the exception, named `<name>-command.ts` for the one `dim` command `<name>` each holds. A test sits beside its module as `<module>.test.ts`. The wall is the one directory, `wall/`, because it is a separate app that only reads the record; its files drop the prefix.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `cli` | Dispatch a command and print its result or error as one JSON line; `*-command.ts` are the commands |
| `config` | Read settings, and edit tools' JSONC configs |
| `db` | Open, lock and read the SQLite store, and its schema |
| `ingest` | Read session sources, hook events and git history into the database, on a schedule |
| `guidance` | Which rules files were in force, and the walk that loaded them |
| `query` | The named queries and how they window and cap their rows |
| `recall` | Handoffs and explicit retrieval |
| `session-start`, `wake` | Repo commands passed to a new session |
| `order` | An order: its lifecycle, ledger, evidence, findings, ship and queue |
| `station` | The plan, build and review stations: briefs, turns, artifacts and the build runner |
| `worker` | Who a worker is: assignment, the process it is registered as, roles, routing and capabilities |
| `harness` | Starting a worker under Claude Code, Codex, or Grok Build |
| `factory` | The floor: stop and operator |
| `ship` | Landing an order on the trunk, and its rebase |
| `check` | The check sandbox |
| `gate`, `comments`, `hooks`, `skill`, `rules`, `install` | Install and enforce the shared controls |
| `git`, `repo`, `worktree`, `workspace` | Repositories, what they declare, and task worktrees |
| `wall/` | The read-only board; `components/` and `lib/` hold its UI primitives |
| `trace` | Diagnostic events |

## Where to start

- `cli-commands.ts` lists the commands, each loaded only when it runs, so a hook pays for one; `cli-contract.ts` is what one is.
- `db-schema.ts` holds every table and the reason for its shape.
- `query-registry.ts` lists the named queries.
- `order-lifecycle.ts`, `order-ledger.ts` and `order-status.ts` hold what an order is and how it moves, and `order-state.ts` reads its next act from the record.
- Read a module's `.test.ts` before changing its contract.

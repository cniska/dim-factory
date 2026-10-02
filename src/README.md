# src/

Flat, so a module is found by name. A file's prefix is its module: `db-read.ts` belongs to `db`, `ingest-spool.ts` to `ingest`. A module that is one file carries its bare name (`doctor.ts`, `paths.ts`). A test sits beside its module as `<module>.test.ts`. The wall is the one directory, `wall/`, because it is a separate app that only reads the record; its files drop the prefix.

A module's files are named for their layer:

| File | Holds |
| --- | --- |
| `<module>.ts` | The module's rules as pure functions |
| `<module>-contract.ts` | Its types, schemas and refusals, what other modules import |
| `<module>-ops.ts` | The operations commands and other modules call |
| `<module>-effects.ts` | The side effects its operations run: processes, git, files |
| `<module>-store.ts` | Its SQL and the mapping from rows |
| `<name>-command.ts` | The one `dim` command `<name>`: parse the arguments, call the operations, return the result |

The factory's modules follow this shape. The record's modules predate it and are named by step instead (`ingest-parse-claude.ts`, `ingest-spool.ts`).

## Modules

| Prefix | Responsibility |
| --- | --- |
| `order` | An order's log, its state folded from the log, and the acts the operator takes on it |
| `station` | A station's turn: the brief, the worker's acts it serves, and its definition of done |
| `slice` | The gates a builder's commit passes before the factory keeps it |
| `ship` | Rebasing an approved order onto the default branch, checking it and landing it |
| `workspace` | The linked worktree an order is built in |
| `worker` | Workers, their sessions, and who a `dim` command acts as |
| `harness` | Starting and stopping a worker's harness process, and which harnesses are installed |
| `check` | Running a project's declared check in a sandbox with a listed environment |
| `plan`, `build`, `review`, `finding`, `message` | The commands a station's worker runs during its turn, one file each |
| `session` | The operator's command that prints a worker's transcript |
| `trace` | The factory's diagnostic steps, for `dim trace` |
| `ingest`, `agent` | Read session sources, hook events and git history into the record, on the schedule the launchd agent sets |
| `db` | Open, lock and read the SQLite record, and its schema |
| `query`, `sql` | The named queries over the record, and raw read-only SQL |
| `session-start` | The repo's declared commands, passed to a new session |
| `config` | Read settings, and edit tools' JSONC configs |
| `comments`, `hooks`, `skill`, `rules` | Install the shared controls |
| `git`, `repo`, `worktree`, `project`, `declared` | Repositories, their checkouts, what they declare, and folding worktree paths onto their checkout |
| `doctor` | Report what is installed and what is out of date |
| `cli` | Dispatch a command and print its result or refusal as one JSON line |
| `wall/` | The read-only board; `components/` and `lib/` hold its UI primitives |
| `coded-error`, `assert`, `paths` | Refusals with a code; `unreachable` and `invariant`; where every file lives |

## Where to start

- `cli-commands.ts` lists the commands, each loaded only when it runs, so a hook pays for one; `cli-contract.ts` is what one is.
- `order-contract.ts` holds every action an order's log records; `order.ts` folds them into the order's state.
- `db-schema.ts` holds the record's tables; `order-store.ts` and `worker-store.ts` hold the factory's.
- `query-registry.ts` lists the named queries.
- Read a module's `.test.ts` before changing its contract.

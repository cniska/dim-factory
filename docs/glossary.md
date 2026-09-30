# Glossary

One word per thing. A page that uses a word links here rather than defining it again.

## The factory

| Term | Definition |
|---|---|
| Owner | The person the factory runs for. They approve artifacts and read the wall |
| Operator | The worker that runs the line: adds and runs orders and carries out the owner's decisions. It never does a station's work |
| Worker | A lasting identity the factory records, named like `nut-7`, with one role. Every action on an order names the worker that took it |
| Session | The harness process that currently carries a worker's context. A worker's session can die and be replaced; the worker stays |
| Role | What a worker is: `operator`, `planner`, `builder` or `reviewer` |
| Model strength | The strength of model a role runs on, `standard` or `deep`, mapped to this machine's models per harness |
| Harness | The agent product that runs a session, such as Claude Code or Codex |
| Station | One step of work on an order: `plan`, `build` or `review`. Their skills are `dim-plan`, `dim-build` and `dim-review` |
| Order | One piece of work: a title, the owner's request and a project. It waits until the operator runs it, and is built in its own workspace and branch |
| Workspace | The isolated checkout an order is built in, with its own branch, apart from the project's checkout and every other order's. A git worktree is how one is made |
| Status | The state an order is in, read from its log: `queued`, `running`, `shipped` or `cancelled`. The wall's columns are these words, and a cancelled order leaves the board |
| Next step | What an order waits on, worked out from its log alone: `run`, `approve`, `revise` or `decide`. An action that is not the next step is refused |
| Slice | One increment of a plan, with a title and its outcome, that the builder commits on its own |
| Ship | Landing an order's commits on the project's default branch, which ends the order |
| Command | One `dim` subcommand, in the `src/<name>-command.ts` named for it ([`src/cli-contract.ts`](../src/cli-contract.ts)) |
| Command line | The text a shell runs, such as `bun run verify` |
| Declared task | What a repo declares in its manifest — a `package.json` script, a `mise` task, a `Makefile` target — read, never inferred ([`src/declared-tasks.ts`](../src/declared-tasks.ts)). The check is the task that says a change is sound |

## The record

| Term | Definition |
|---|---|
| Log | An order's one list of actions, each naming who took it, appended and never changed |
| Evidence | What an action produced, such as a check's output, attached to that action in the log |
| Artifact | What a station's worker returns for the owner — the plan, the Build artifact or the Review artifact. The operator approves or returns it on the owner's decision |
| Worker's return | A station worker handing the order back: a planner that cannot plan it as written, or a builder or reviewer that found a problem in the previous station's work |
| Cancel | The owner's decision to stop an order before it ships, with the reason |
| Finding | A problem a reviewer raised, with its area, file and line, what is wrong, the fix and a severity |
| Severity | How much a finding costs if it ships: `critical`, `high` or `medium` |
| Answer | The builder's one reply to a finding: `fixed`, or `refused` with a reason |
| Gate | A rule git or `dim` refuses to let pass, whether or not anything was read |
| Comment gate | The part of the commit gate that refuses a new comment in a JS or TS file, in a repo that bans them ([`usage.md`](usage.md#comment-gate)) |
| Config | `dim`'s settings, from the user's and the project's JSON layers ([`usage.md`](usage.md#configuration)) |
| Setting | One named entry of the config, taking one of a fixed set of values |

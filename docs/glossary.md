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
| Harness | The agent product that runs a session, such as Claude Code or Codex |
| Station | One step of work on an order: `plan`, `build` or `review` |
| Instructions | What a worker or the operator is told to do. A station's are markdown in `prompts/` that its worker starts with in its system prompt; the operator's are the `dim-factory` skill |
| Order | One piece of work: a title, a description and a project. It waits until the operator runs it, and is built in its own workspace and branch |
| Workspace | The isolated checkout an order is built in, with its own branch, apart from the project's checkout and every other order's. A git worktree of the checkout is how one is made |
| Status | The state an order is in, read from its log: `queued`, `running`, `shipped` or `cancelled`. The wall's columns are these words, and a cancelled order leaves the board |
| Admits | The operator actions an order accepts now, worked out from its log alone. Any other action is refused, naming these |
| Next step | The admitted action that moves an order on: `run`, `approve` or `update` |
| Update | The operator's change to an order's title or description, allowed until its plan is approved, or once the planner returns the order. The next run plans the order again |
| Turn | One run of a station worker's session: the factory starts or resumes it with a brief and serves the acts it sends until its process ends |
| Message turn | A turn that resumes a station worker's session with the operator's message instead of a brief. It only reads, and its final text is the reply |
| Brief | The JSON a turn starts with: the order's facts and where the station stands. It carries no instructions |
| Turn socket | The Unix socket a turn opens for its worker. It is the worker's only way to write the record, and any connection to it acts as that worker |
| Run | A turn or a ship in flight on an order, recorded with its process so another act on the order is refused while it is alive |
| Stop | A log entry that carries a code and the facts behind it: a refused slice, ship or message, a session's death or a failed station |
| Trace | The run's record of each trace step: one thing the factory did on its own, such as a rebase, a check or a log append, with its time and outcome. It is for diagnosing the factory, and no state is read from it |
| Slice | One increment of a plan, with a title and its outcome, that the builder commits on its own |
| Ship | Landing an order's commits on the project's default branch, which ends the order |
| Command | One `dim` subcommand, in the `src/<name>-command.ts` named for it ([`src/cli-contract.ts`](../src/cli-contract.ts)) |
| Command line | The text a shell runs, such as `bun run check` |
| Slash command | The `/name` a user types into a harness, such as `/clear` or `/dim-factory` |
| Declared task | What a repo declares in its manifest — a `package.json` script, a `mise` task, a `Makefile` target — read, never inferred ([`src/declared-tasks.ts`](../src/declared-tasks.ts)) |
| Language | A language the project's tracked source is written in, found from file extensions, such as TypeScript ([`src/languages.ts`](../src/languages.ts)). It decides which writing guidance the builder and the reviewer get |
| Ecosystem | A language and its tooling, found from the manifests and lockfiles a project tracks, such as `package.json` or `bun.lock` ([`src/ecosystems.ts`](../src/ecosystems.ts)). It decides how dependencies install and which per-language parts of a gate a project gets |
| Check | The declared task that says a change is sound: the one the project's `tasks.check` setting names, or else the task named `check`. The `check` gate runs it before a commit, and the factory runs it on a returned build's head and before a ship |

## The record

| Term | Definition |
|---|---|
| Log | An order's one list of actions, each naming who took it, appended and never changed |
| Spool | The directory where session hooks drop one file per event, which `dim sync` reads into the record, so a hook never waits on the database |
| Evidence | What an action produced, such as a check's output, attached to that action in the log |
| Artifact | What a station's worker returns for the owner — the plan, the Build artifact or the Review artifact. The operator approves or returns it on the owner's decision |
| Worker's return | A station worker handing the order back: a planner that cannot plan it as written, or a builder or reviewer that found a problem in the previous station's work |
| Cancel | The owner's decision to stop an order before it ships, with the reason |
| Finding | A problem a reviewer raised, with its area, file and line, what is wrong, the fix and a severity |
| Area | The question a review or audit reads code against, such as correctness or tests ([`prompts/references/quality-areas.md`](../prompts/references/quality-areas.md)) |
| Severity | How much a finding costs if it ships: `critical`, `high` or `medium` |
| Answer | The builder's one reply to a finding: `fixed`, or `refused` with a reason |
| Gate | A rule git or `dim` refuses to let pass, whether or not anything was read |
| Slice gate | A gate the factory runs on a slice's commit, for what reading the change cannot show |
| Canonical gates | The gates dim-factory runs on itself, which a project chooses from and installs: `commit-subject` (the subject rule at commit and on push), `check` (the declared check before a commit) and `no-comments` (the comment ban at commit and on push). A gate is named for its rule, never for a hook or file it installs |
| Config | `dim`'s settings, from the user's and the project's JSON layers ([`usage.md`](usage.md#configuration)) |
| Setting | One named entry of the config |

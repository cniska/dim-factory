# The factory core

How `dim` runs an order from added to shipped: what it stores, how it decides, how it starts workers and what it lets them do. The words are the [glossary](glossary.md)'s. The acceptance suite under [`acceptance/`](../acceptance/) is the contract this design is built to.

## Shape

Two bounded contexts share one SQLite file and own disjoint tables.

- **The session record** reads every harness session on the machine: ingestion, hooks, queries ([`design.md`](design.md)). The core reads it only through its published functions, such as the session that ran above a process.
- **The factory** owns orders, workers, their sessions and runs. Everything below is the factory.

The factory opens the file through `src/factory-db.ts`, which calls the record's `openDb` or `openReadOnly` and then runs each factory store's DDL. No record module names a factory table.

Each factory module has a rules file of pure functions, a `-contract.ts` of types, schemas and its refusals, a `-store.ts` holding its SQL, `-effects.ts` where it touches git, processes or files, and `-ops.ts`: the operations other modules and commands call, composed from the rest. The rules, the contract and the ops are the module's public API; `-ops.ts` holds only what has a caller outside the module. A command file parses arguments, calls the ops, and prints the result.

| Module | Holds |
|---|---|
| `order` | The log, the fold that works out an order's state, and which action is allowed next |
| `worker` | Worker names, roles and sessions, and who a process acts as |
| `station` | Briefs, the acts a worker may send, each station's definition of done, and running a turn |
| `harness` | A registry of adapters, one per harness: how to start, resume and replace a session, and how to read its stream. Claude Code is the adapter built |
| `workspace` | Creating and removing an order's workspace and branch |
| `slice` | Gating the builder's commits |
| `ship` | Rebasing an order onto the default branch, checking it and landing it |
| `check` | Running the project's declared check in a sandbox with a listed environment |
| `paths` | The one XDG layout |

`src/assert.ts` (`unreachable`, `invariant`) is the first file. Schemas use `zod`, parsed once where input enters: the CLI, the turn socket, a settings file, a harness stream.

## Paths

One layout, resolved in `src/paths.ts`, like acolyte's. A relative XDG value is ignored, as the XDG spec says. There is no `DIM_HOME`; a test isolates `dim` by setting the three XDG variables.

| Category | Default | Holds |
|---|---|---|
| Config | `$XDG_CONFIG_HOME/dim` | `config.json` (the user's settings) and `hooks/` (the commit gate's git hooks) |
| Data | `$XDG_DATA_HOME/dim-factory` | `record/` (the SQLite record and the hook spool), `workspaces/<owner>/<repo>/<order>/`, `workers/<name>/home/` (each station worker's `HOME`), `workers/<name>/sessions/<session>.jsonl` (the factory's copy of each of its transcripts) |
| State | `$XDG_STATE_HOME/dim-factory` | `trace.jsonl`, `locks/` and `sync.log` (the scheduled sync's output) |

The record sits in its own directory so a worker's sandbox can deny writes to it without also denying the workspaces beside it. A project's settings are its committed `.dim/config.json`. Settings: `ship` (one value, `default-branch`), `harness` (which harness a new session starts under; required, since no harness is right for everyone), `comments`, and in the user's layer only, `models`.

## The log

Each order has one log: an append-only table of entries, each with a per-order `seq`, a time, who took it, an action and that action's typed details. A trigger refuses any `UPDATE` or `DELETE`. An entry is a union discriminated on `action`: shared fields plus required details per action, never a bag of optional fields.

- **Who took it** is either a worker and its session, or the factory with its version and the `seq` of the entry that caused it. A factory landing names the approval it followed from.
- **Evidence** sits on the entry that produced it: the check's output on a committed or refused slice, and the check and the rebase on a landing.
- **A decision** records its reason. An approval or return also records whether the owner decided it or handed it to the operator (`--decided owner|operator`). A stop records its cause as a code with its details.
- The actions are the acceptance suite's vocabulary ([`acceptance/support/vocabulary.ts`](../acceptance/support/vocabulary.ts)). The operator's decision on an artifact is `artifact_approved` or `artifact_returned`; a worker handing the order back is `order_returned`.

- `workspace_created` records the commit an order's branch starts from. The factory records it, caused by the order's first `order_run`, before it makes the workspace.

Order ids and worker names are made by the domain before they are written. A store never mints them. An order id is eight characters of Crockford base32, such as `k7m2qx4d`: a legal branch component and path segment on a case-insensitive filesystem, with no `-`, so it never reads as a worker name.

The factory's tables are `worker`, `worker_session`, `order_log` and `run`. Everything else, such as an order's title, plan, findings and dead sessions, is read from the log.

## Working out what comes next

An order's state is a fold over its log, a pure function: status, station, next step, the plan's slices and which are committed, the open findings, and the branch's recorded head. The same function answers every command, the wall and `order show`, so no second copy of the state is stored.

- The next step is `run`, `approve` or `update`, or none once the order is shipped or cancelled. `update` is next after a planner's return.
- `admit(state, act)` decides whether an act is allowed, and refuses a step that is not next with `not_next_step`, naming the next step. It changes nothing.
- **Two acts are not steps.** `order update` is allowed until the plan is approved and sends the order back to `run`, which plans it again. `order cancel` is allowed until the ship starts.
- **Busy** is not part of the state. A run table holds each station turn or ship in flight: the process running it, the harness process it started, and each one's start time. A run, approval, return or update on an order whose run is alive is refused `order_busy`; so is a cancel while the order ships. A process that has ended no longer counts, so nothing has to stay running to notice a turn is over. A matching pid with a different start time is a different process.
- **Every write a turn makes after its worker ends is decided against a fresh fold.** A turn whose order is no longer running records nothing. A cancel records `order_cancelled` first, then kills the turn's process group, so the dying turn records nothing.
- **Repair** runs at the start of every run, on a run whose process is gone. It needs no judgement.
  - A lost turn's run row is cleared and its orphaned harness process group is killed. Its session is resumed by the next turn, and replaced if it cannot be resumed.
  - A branch commit the record does not hold is taken off the branch, and its changes are left in the workspace.
  - An interrupted ship runs again from the recorded head: the checkout's branch and the workspace are moved to it, and a default branch that already holds the order's tip lands as a fast-forward to itself.
  - Anything else is reported to the operator with its cause.

## Who a command acts as

A command acts as the worker whose registered session is the nearest ancestor of the process running it. A session is registered with its process id and start time. Nothing a worker sets, such as an environment variable or a flag, changes the answer, and no command takes a `--by`.

- **The operator** is one worker per project. An operator act from a process no registered session runs above registers the nearest ancestor that the session record shows as a live harness session in the project as the operator's next session, creating the operator on the project's first act, and refuses with `no_session` when there is none. While another of the operator's sessions is alive, the act is refused `not_operator`. A refused act registers nothing.
- **A station worker's session** is registered by the station that starts it, at spawn.
- The same answer serves every surface. The session-start and edit hooks do nothing in a station worker's session. That is also why the hook spool needs no worker segment in its file names.

## Stations and turns

`dim order run`, `approve` and `return` each run a station turn in their own process, and return when it ends. The command that starts a station returns with its outcome. A turn that ends in the worker's return, or in review findings, reports success, because the order moved. A failed turn is a refusal carrying its code.

A station turn:

1. Writes its run row, then gives the worker a session: resumes the current one, or replaces a dead one.
2. Opens a Unix socket in a fresh `0700` directory under `/tmp`, short enough for macOS's socket path limit, and passes its path to the worker in the environment.
3. Spawns the harness in its own process group, with the brief, the role's model and the worker's sandbox.
4. Serves each act the worker sends over the socket and replies with the result or a coded refusal. A read, such as `order show`, is answered; a work act is admitted for its own station, carried out and recorded. Anything but a coded refusal ends the turn.
5. Reads the stream until the process ends, copies the session's transcript into `workers/<name>/sessions/`, closes the socket and deletes the run row.

- **A worker writes the record only through its turn's socket.** Its sandbox cannot write the record, so every worker act is a request to its station. A worker's queries (`dim query`) open the record read-only themselves, which SQLite allows while the station holds it open. After the turn closes the socket is gone, and a late act records nothing.
- **The socket is the credential.** Its path is known only from the worker's environment, and any connection to it acts as that worker. There is no process check: Bun exposes no peer credentials, and a process that can read the worker's environment already has every power of the user. Real Claude Code's sandbox blocks Unix sockets it isn't told about, so the settings list the turn's socket as allowed.
- **Worker commands:** `plan return <file>`, `slice submit`, `finding answer <id> fixed|refused --reason`, `build return <file>`, `review return --findings <file> | --artifact <file>`, `order return --reason`, `message send <text> [--to <station>]`, `order show`, `session show` for reading a transcript, and `query` for reading the record.
- **The definition of done** is checked on the return, as a pure function of the state and the returned value. A return that misses it records nothing, and the refusal is the reply the worker reads. A second miss in the same turn fails the station, stops the worker and refuses every later act. That stop is the station's failure, not a dead session.
  - The plan comes back with prose and at least one slice, each with a title and an outcome.
  - The build: every slice of the plan is committed, the branch is at the recorded head with a clean workspace, every finding it was given is answered once, and the Build artifact is back.
  - The review: findings, each with an area, a file, a line, what is wrong, the fix and a severity; or the Review artifact, naming the areas it covered.
- A turn that ends with no accepted return fails the station with `no_return`, and the session stays. A session has died when its harness reported no finished result (`usage_limit`, `killed`) or when a resume or fork never started it (`resume_failed`: no `init` event in the stream). `session_died` records whether the factory holds a copy of its transcript. A dead session fails the station with `session_died`, and the next run replaces it; a resume that fails is replaced in the same run, with no failed station recorded.
- **Slices map to the plan by position:** the nth commit of a build is the plan's nth slice. A commit after the last slice is a fix, answering a finding or resolving a conflict. A revised plan after a return to plan says which committed slices stay, and its slices are counted from the branch as it stands.

**A message turn** is its own kind. `dim message send` from the operator resumes the named station worker's session with the message as the prompt, admits only reads (`order show`, `session show`), and has no definition of done. The turn's final text is the reply. Both are logged as `message_sent`. A station worker's message to anyone but the operator is logged as `message_refused` and not delivered.

## Briefs

A brief is JSON with a fixed set of keys per station. A key with no value is `null`, never absent, so every order's brief has the same keys. It holds facts and names the skill; it carries no instructions.

- **plan:** `skill`, `order` (id, title, project, description), `workspace`, `returned` (why the order came back: the operator's reason, or a builder's return), `committed` (slices already on the branch).
- **build:** `skill`, `order`, `workspace`, `plan`, `returned` (the operator's reason, or the check that failed at ship with its output), `findings` with their ids, `conflict` (the paths a rebase stopped on).
- **review:** `skill`, `order`, `workspace`, `build` (the Build artifact), `diff` (the order's diff against the default branch), `answers` (the builder's answers to the last findings), `returned`.

## Starting a worker

The Claude Code adapter starts `claude -p --output-format stream-json --verbose` with `--model`, `--permission-mode`, `--settings`, `--setting-sources user`, `--plugin-dir` (the installed `dim`'s checkout, whose `.claude-plugin` loads its `skills/` as the `dim` plugin, since the worker's own `HOME` holds none), and `--session-id`, or `--resume`, or `--resume <dead> --fork-session`. It is spawned with an open stdin and given the brief there once its session is registered; `claude -p` waits three seconds for it ([`findings.md`](findings.md#harness-behavior)). It reads the stream for the session id, the final result and a rejected rate limit. The fake in [`acceptance/support/scripted-claude.ts`](../acceptance/support/scripted-claude.ts) refuses any other flag.

- **`HOME`:** each station worker has its own, `workers/<name>/home/`, so it reads nothing of the owner's home. The harness keeps its transcripts there, with its own pruning turned off in the `--settings` JSON. Workers and tests read a transcript through `dim session show`, which prints the factory's copy as its `lines`, each as written. That a fresh `HOME` signs in with only `CLAUDE_CODE_OAUTH_TOKEN` in `-p` mode is checked against a real `claude` before this lands.
- **Environment:** a listed set only: `HOME` (the worker's), `PATH`, `USER`, `LANG`, `TMPDIR` (the turn's), the three XDG variables, the turn socket, `GIT_AUTHOR_*` and `GIT_COMMITTER_*` naming the owner as git resolves `user.name` and `user.email` in the checkout (refused `no_git_identity` when it resolves none), `commit.gpgsign=false` through `GIT_CONFIG_COUNT`, and the sign-in the harness needs (`CLAUDE_CODE_OAUTH_TOKEN` for Claude). No other key, token or agent socket of the owner's.
- **Settings:** `--setting-sources user` leaves out the project's `.claude/settings.json`, so no hook from a workspace runs. The worker's own `HOME` holds no settings, so the factory's hooks, the sandbox and the permissions all come in the `--settings` JSON.
- **Sandbox:** the sandbox is on, Bash is allowed only inside it, and it writes only where it is allowed to. The builder, in `acceptEdits`, may write its workspace, which Claude's sandbox allows as the working directory, and its turn's temp directory, within the git limits under slice commits. The planner and reviewer, in `default`, may write only their turn's temp directory, so they change nothing. The record, the factory's code, its skills and every harness config lie outside what any worker may write, in every project, dim-factory included.
- **Model:** the user's `config.json` names one model per role in its `models` setting, `{"default": …, "planner": …, "builder": …, "reviewer": …}`, in the harness's own names. It is read from the user's layer only, and a project's settings that name it are refused. A role it leaves out runs on `default`. With neither, the run is refused `no_model` before anything is recorded.
- **Harness:** a new session starts under the `harness` setting. A session is always resumed under the harness it started under, whatever the setting says now.
- **A replacement session** is the dead session's transcript under a new id. The factory writes its byte copy back to the harness's session file if the harness lost it, then resumes it with `--fork-session` under the new id. A dead session the factory holds no copy of, one killed before its harness wrote anything, is replaced by a new session. The copy is verbatim, not rebuilt from the session record's rows, because a resume needs every line as written: tool results, thinking and the links between lines, which the record does not store. The new session holds what the dead one held as of its last closed turn, whether it hit a usage limit or its file was deleted.
- **Ingestion** reads each worker's `HOME` beside the owner's, so the owner's queries see worker sessions. Their rows stay pointers, like every other session's.

## Slice commits

The builder commits with plain `git commit` in its workspace, then hands the commit in with `dim slice submit`. The factory never makes a builder's commit.

**The record holds the branch's head, and the record wins.** The recorded head starts at `workspace_created`'s commit and moves with each `slice_committed` and `branch_rebased`. Whenever the branch and the record disagree, the factory moves the branch back to the recorded head with `update-ref <branch> <recorded head> <tip>` and leaves the files alone. That one rule refuses a slice, repairs after a kill, and undoes a builder's `--amend`, `reset` or `rebase`. A git hook can't be the gate, because the builder can skip one with `--no-verify` or `-c core.hooksPath`.

On `dim slice submit`, the station:

1. Records `slice_submitted`, the builder's act.
2. Refuses `head_moved` unless the tip is exactly one new commit on the recorded head.
3. Refuses `check_changed` if the declared check's definition at the tip differs from the recorded head's: the check's command line and the whole manifest section that declares it (every `package.json` script, every mise task, the whole `Makefile`). The recorded head holds the default branch's definition as of the order's base or its last rebase, so a slice can never change what judges it.
4. Refuses `workspace_dirty` unless the workspace is clean, so the files on disk are exactly the committed code, and `no_check` if the tip declares no check task. Then it runs the check there, and refuses `check_failed` with the output attached, or `check_rewrote` if the workspace is not clean afterwards.
5. Records `slice_committed` with the commit and the check's output, or `slice_refused` with its code, and then moves the branch back to the recorded head. A refused slice's files stay in the workspace as uncommitted changes.

A kill anywhere in this leaves the branch ahead of the record, and the next turn moves it back. A `git commit` after the turn closes lands on the branch but not in the record, and the next run takes it off.

**A builder's commit is a developer's commit in a worktree of the checkout.** Git resolves its hooks as it would there: the checkout's local `core.hooksPath`, or the shared `.git/hooks`. The worker's own `HOME` holds no git config, so nothing of the owner's global config reaches it. The commit names the owner as author and committer and is not signed.

**The builder's git writes** go to the checkout's git directory, which its worktree shares and Claude's sandbox opens to Bash ([`findings.md`](findings.md#harness-behavior)). The settings deny the checkout's `.git/hooks` directory to Bash and to the harness's edit tool. The checkout's `.git/config` is one file, and a denied file denies its whole directory, so the station reads the config when the turn opens and compares it before it serves each act and when the turn closes. A changed config is put back, and the station fails with `git_config_changed`; checking before each act keeps the station's own git from running a command the builder put there. The planner and reviewer are denied the checkout's whole git directory, so they write no git data. A builder can still move a ref of the checkout, since sandbox rules cannot scope refs; the owner accepts that, and ship lands only what the record holds.

## Ship

Approving the Review artifact ships the order in the same process. Ships of one project take a lock in `locks/` in turn. A second approval waits for the lock, and does not fail as busy.

1. Reads how the project ships from the default branch's settings. A project that does not say is stopped with `ship_unset`.
2. Refuses `checkout_dirty` if a tracked file in the checkout has changes.
3. **Rebases** the order's commits, from the recorded head, onto the default branch's tip, in the checkout: `git merge-tree --write-tree` then `commit-tree` for each, keeping the builder as author with the factory as committer. Nothing is touched until the rebase is known. It records `branch_rebased` with the new head and each moved commit's old and new id, so the order's commits stay its slices, then moves the checkout's branch and resets the workspace to it.
   - **A conflict** at a commit keeps the commits before it as the new head, puts the merge of the rest into the workspace with its conflict markers, records `ship_stopped` with the paths, sends the order to build with those paths as the brief's `conflict`, and refuses with `ship_conflict`. The builder resolves it with an ordinary commit and `slice submit`, and nothing is replayed after it. A slice whose commit the conflict stopped keeps that commit's id; the resolution carries its change.
4. Runs the check on the rebased workspace. A failing check sends the order to build with the check as the brief's `returned`, and refuses with `ship_check_failed`. A rebased tip that declares no check is stopped with `ship_no_check` and waits to ship.
5. **Lands:** `git merge --ff-only` in the checkout if the default branch is checked out there, otherwise `update-ref` against its expected old value. Either one is the single moment the default branch moves, so it holds all of the order's commits or none. A refused fast-forward, such as an untracked file the landing would overwrite, is stopped with `checkout_dirty`.
6. Removes the workspace, and the checkout's branch once the workspace is gone, then records `ship_landed` with the rebase and the check as evidence and what it could not remove in its details: a workspace it could not remove keeps its branch too. When nothing was kept it records `cleaned_up`; otherwise `order clean` records it once the rest is removed.

The check an order is judged by until it ships is the default branch's definition of the declared check, run on the order's code, together with the gates of the installed `dim`. A slice that changes that definition is refused. The code the check runs is the order's to change: tests are code.

## The check

The check runs the declared check task ([`src/declared-tasks.ts`](../src/declared-tasks.ts)) under an OS sandbox that allows writes only to the tree it checks and its own temp directory, with tool caches pointed at that temp directory. Its environment is the worker's list without any sign-in. Its output is evidence, kept to its last 64 KiB so one run cannot swell the log.

## Workspaces

A workspace is `workspaces/<owner>/<repo>/<order>/`: a linked worktree of the project's checkout (`git worktree add`) on the branch `dim/<order>`, made when the order first runs. It shares the checkout's refs, objects and config, so the order's branch is read and shipped in the checkout with nothing to copy. It lives outside the project, so no harness sees it as nested in another checkout. Cleaning up runs `git worktree remove` and then deletes the branch. A project named with `--project` from outside its checkout is found through the checkout the record last saw for it.

## The trace

`trace.jsonl` in the state directory holds one line per factory step, keyed by order. `dim trace <order>` prints the order's lines and follows the file as it grows. `dim trace clear` empties it. No order state reads it. `dim trace <order>` first finds the order in the record, so it refuses a record of another version like every reader. The record's `trace_event` table goes with the move to this file.

## Record versions

The record carries one schema version for the whole file, the session record's tables and the factory's, as `PRAGMA user_version`; it replaces the `schema_version` table. A fresh file gets its tables and its version in one transaction. Every writer and reader refuses another version with `record_version`, naming the repair. `dim doctor` reads any version so it can report the mismatch, and `dim rebuild`, the repair it names, is the one writer that opens an older version: it drops and re-derives only the session tables it names, so the factory's tables carry across untouched. A change to a factory table's shape is a one-off carry in `rebuild-command.ts`, deleted once it has run; while orders are disposable, it resets the factory instead.

## Commands and output

The command names are whole words with subcommands (`dim order approve`, `dim hooks install`, `dim query search`), hooks included. Bare `dim` lists the commands. The operator's: `order add|run|approve|return|update|cancel|show|clean`, `message send`, `session show`, `trace`. `order clean` succeeds on an order already cleaned up.

Each command prints one line of JSON. A refusal carries `code`, `message`, `meta` and `resolve`, the `dim` command that resolves it. Each module's contract builds its refusals from one table keyed by every code, holding each code's message and resolve, so a new code does not compile until it says how it is resolved.

## The wall

The wall reads the same fold through a read-only connection and shows each order's title, project, station and worker in its status column. The UI stays on [`src/wall/wall-contract.ts`](../src/wall/wall-contract.ts) until the owner asks for the wall to be adapted.

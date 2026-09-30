# The factory core

How `dim` runs an order from added to shipped: what it stores, how it decides, how it starts workers and what it lets them do. The words are the [glossary](glossary.md)'s. The acceptance suite under [`acceptance/`](../acceptance/) is the contract this design is built to.

## Shape

Two bounded contexts share one SQLite file and own disjoint tables.

- **The session record** reads every harness session on the machine: ingestion, hooks, queries ([`design.md`](design.md)). The core reads it only through its published functions, such as the session that ran above a process.
- **The factory** owns orders, workers, their sessions and runs. Everything below is the factory.

Each factory module has a rules file of pure functions, a `-contract.ts` of types and schemas, a `-store.ts` holding its SQL, and `-effects.ts` where it touches git, processes or files. A command file parses arguments, calls the rules and effects, and prints the result.

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
| Config | `$XDG_CONFIG_HOME/dim` | `config.json` (the user's settings) and `models.json` (which model is which strength, per harness) |
| Data | `$XDG_DATA_HOME/dim-factory` | `record/` (the SQLite record and the hook spool), `workspaces/<owner>/<repo>/<order>/`, `workers/<name>/home/` (each station worker's `HOME`), `workers/<name>/sessions/<session>.jsonl` (the factory's copy of each of its transcripts) |
| State | `$XDG_STATE_HOME/dim-factory` | `trace.jsonl` and `locks/` |

The record sits in its own directory so a worker's sandbox can deny writes to it without also denying the workspaces beside it. A project's settings are its committed `.dim/config.json`. Settings: `ship` (one value, `default-branch`), `harness` (which harness a new session starts under; required, since no harness is right for everyone), `comments`.

## The log

Each order has one log: an append-only table of entries, each with a per-order `seq`, a time, who took it, an action and that action's typed details. A trigger refuses any `UPDATE` or `DELETE`. An entry is a union discriminated on `action`: shared fields plus required details per action, never a bag of optional fields.

- **Who took it** is either a worker and its session, or the factory with its version and the `seq` of the entry that caused it. A factory landing names the approval it followed from.
- **Evidence** sits on the entry that produced it: the check's output on a committed or refused slice, and the check and the rebase on a landing.
- **A decision** records its reason. An approval or return also records whether the owner decided it or handed it to the operator (`--decided owner|operator`). A stop records its cause as a code with its details.
- The actions are the acceptance suite's vocabulary ([`acceptance/support/vocabulary.ts`](../acceptance/support/vocabulary.ts)), plus `order_updated` and `branch_rebased`.

Order ids and worker names are made by the domain before they are written. A store never mints them.

## Working out what comes next

An order's state is a fold over its log, a pure function: status, station, next step, the plan's slices and which are committed, the open findings, and the branch's recorded head. The same function answers every command, the wall and `order show`, so no second copy of the state is stored.

- The next step is `run`, `approve` or `update`, or none once the order is shipped or cancelled. `update` is next after a planner's return.
- `admit(state, act)` decides whether an act is allowed, and refuses a step that is not next with `not_next_step`, naming the next step. It changes nothing.
- **Two acts are not steps.** `order update` is allowed until the plan is approved and sends the order back to `run`, which plans it again. `order cancel` is allowed until the ship starts.
- **Busy** is not part of the state. A run table holds each station turn or ship in flight: the process running it, the harness process it started, and each one's start time. A run, approval, return or update on an order whose run is alive is refused `order_busy`; so is a cancel while the order ships. A process that has ended no longer counts, so nothing has to stay running to notice a turn is over. A matching pid with a different start time is a different process.
- **Every write a turn makes after its worker ends goes through `admit` against a fresh fold.** A cancel records `order_cancelled` first, then kills the turn's process group, so the dying turn records nothing.
- **Repair** runs at the start of `order run` on a run whose process is gone. It needs no judgement.
  - A lost turn is closed, and its orphaned harness process is killed. A session that cannot be resumed is replaced.
  - A branch commit the record does not hold is taken off the branch, and its changes are left in the workspace.
  - An interrupted ship is finished if the default branch already holds the order's tip. Otherwise it is rolled back.
  - Anything else is reported to the operator with its cause.

## Who a command acts as

A command acts as the worker whose registered session is the nearest ancestor of the process running it. A session is registered with its process id and start time. Nothing a worker sets, such as an environment variable or a flag, changes the answer, and no command takes a `--by`.

- **The operator** registers with `dim operator register`. It finds the nearest ancestor that the session record shows as a live harness session in the project, and refuses with `no_session` when there is none. A second live operator session in the project is refused. A new session, once the old one has ended, becomes a new operator worker that takes over the project's orders and receives its workers' messages.
- **A station worker's session** is registered by the station that starts it, at spawn.
- The same answer serves every surface. The session-start and edit hooks do nothing in a station worker's session. That is also why the hook spool needs no worker segment in its file names.

## Stations and turns

`dim order run`, `approve` and `return` each run a station turn in their own process, and return when it ends. The command that starts a station returns with its outcome. A turn that ends in the worker's return, or in review findings, reports success, because the order moved. A failed turn is a refusal carrying its code.

A station turn:

1. Writes its run row, then gives the worker a session: resumes the current one, or replaces a dead one.
2. Opens a Unix socket in a fresh `0700` directory under `/tmp`, short enough for macOS's socket path limit, and passes its path to the worker in the environment.
3. Spawns the harness in its own process group, with the brief, the model for the role's strength and the worker's sandbox.
4. Serves each act the worker sends over the socket: admits it, carries it out, records it, and replies with the result or a coded refusal.
5. Reads the stream until the process ends, copies the session's transcript into `workers/<name>/sessions/`, closes the socket and deletes the run row. Repair takes the same copy when it closes a lost turn.

- **A worker reaches the record only through its turn's socket.** Its sandbox cannot write the record, and a SQLite reader needs to write a WAL database's `-shm` file. So every worker command, `order show` included, is a request to its station. After the turn closes the socket is gone, and a late act records nothing.
- **The socket is the credential.** Its path is known only from the worker's environment, and any connection to it acts as that worker. There is no process check: Bun exposes no peer credentials, and a process that can read the worker's environment already has every power of the user. Real Claude Code's sandbox blocks Unix sockets it isn't told about, so the settings list the turn's socket as allowed.
- **Worker commands:** `plan return <file>`, `slice submit`, `finding answer <id> fixed|refused --reason`, `build return <file>`, `review return --findings <file> | --artifact <file>`, `order return --reason`, `message send <text> [--to <station>]`, `order show`, and `session show` for reading a transcript.
- **The definition of done** is checked on the return, as a pure function of the state and the returned value. A return that misses it records nothing, and the refusal is the reply the worker reads. A second miss in the same turn fails the station, stops the worker and refuses every later act. That stop is the station's failure, not a dead session.
  - The plan comes back with prose and at least one slice, each with a title and an outcome.
  - The build: every slice of the plan is committed, the branch is at the recorded head with a clean workspace, every finding it was given is answered once, and the Build artifact is back.
  - The review: findings, each with an area, a file, a line, what is wrong, the fix and a severity; or the Review artifact, naming the areas it covered.
- A turn that ends with no accepted return fails the station with `no_return`, and the session stays. A session has died when its harness reported no finished result (`usage_limit`, `killed`) or when resuming it fails (`resume_failed`, read from the exit status).
- **Slices map to the plan by position:** the nth commit of a build is the plan's nth slice. A commit after the last slice is a fix, answering a finding or resolving a conflict. A revised plan after a return to plan says which committed slices stay, and its slices are counted from the branch as it stands.

**A message turn** is its own kind. `dim message send` from the operator resumes the named station worker's session with the message as the prompt, admits only reads (`order show`, `session show`), and has no definition of done. The turn's final text is the reply. Both are logged as `message_sent`. A station worker's message to anyone but the operator is logged as `message_refused` and not delivered.

## Briefs

A brief is JSON with a fixed set of keys per station. A key with no value is `null`, never absent, so every order's brief has the same keys. It holds facts and names the skill; it carries no instructions.

- **plan:** `skill`, `order` (id, title, project, description), `workspace`, `returned` (why the order came back: the operator's reason, or a builder's return), `committed` (slices already on the branch).
- **build:** `skill`, `order`, `workspace`, `plan`, `returned`, `findings` with their ids, `conflict` (the paths a rebase stopped on).
- **review:** `skill`, `order`, `workspace`, `build` (the Build artifact), `diff` (the order's diff against the default branch), `answers` (the builder's answers to the last findings), `returned`.

## Starting a worker

The Claude Code adapter starts `claude -p --output-format stream-json --verbose` with `--model`, `--permission-mode`, `--settings`, `--setting-sources user`, and `--session-id`, or `--resume`, or `--resume <dead> --fork-session`. It reads the stream for the session id, the final result and a rejected rate limit. The fake in [`acceptance/support/scripted-claude.ts`](../acceptance/support/scripted-claude.ts) refuses any other flag.

- **`HOME`:** each station worker has its own, `workers/<name>/home/`, so it reads nothing of the owner's home. The harness keeps its transcripts there, with its own pruning turned off in the `--settings` JSON. Workers and tests read a transcript through `dim session show`, which reads the factory's copy. That a fresh `HOME` signs in with only `CLAUDE_CODE_OAUTH_TOKEN` in `-p` mode is checked against a real `claude` before this lands.
- **Environment:** a listed set only: `HOME` (the worker's), `PATH`, `USER`, `LANG`, `TMPDIR` (the turn's), the three XDG variables, the turn socket, and the sign-in the harness needs (`CLAUDE_CODE_OAUTH_TOKEN` for Claude). No other key, token or agent socket of the owner's.
- **Settings:** `--setting-sources user` leaves out the project's `.claude/settings.json`, so no hook from a workspace runs. The worker's own `HOME` holds no settings, so the factory's hooks, the sandbox and the permissions all come in the `--settings` JSON.
- **Sandbox:** the sandbox is on, Bash is allowed only inside it, and it writes only where it is allowed to. The builder, in `acceptEdits`, may write its workspace, its turn's temp directory and the git paths listed under slice commits. The planner and reviewer, in `default`, may write only their turn's temp directory, so they change nothing. The record, the factory's code, its skills and every harness config lie outside what any worker may write, in every project, dim-factory included.
- **Model:** the role's strength (planner and reviewer `deep`, builder `standard`) looked up in `models.json` for the harness. A missing entry refuses the turn and names what is missing.
- **Harness:** a new session starts under the `harness` setting. A session stays on the harness it started under, and resuming it under another is refused.
- **A replacement session** is the dead session's transcript under a new id. The factory writes its byte copy back to the harness's session file if the harness lost it, then resumes it with `--fork-session`. The copy is verbatim, not rebuilt from the session record's rows, because a resume needs every line as written: tool results, thinking and the links between lines, which the record does not store. The new session holds what the dead one held as of its last closed turn, whether it hit a usage limit or its file was deleted.
- **Ingestion** reads each worker's `HOME` beside the owner's, so the owner's queries see worker sessions. Their rows stay pointers, like every other session's.

## Slice commits

The builder commits with plain `git commit` in its workspace, then hands the commit in with `dim slice submit`. The factory never makes a builder's commit.

**The record holds the branch's head, and the record wins.** Whenever the branch and the record disagree, the factory moves the branch back to the recorded head with `update-ref <branch> <recorded head> <tip>` and leaves the files alone. That one rule refuses a slice, repairs after a kill, and undoes a builder's `--amend`, `reset` or `rebase`. A git hook can't be the gate, because the builder can skip one with `--no-verify` or `-c core.hooksPath`.

On `dim slice submit`, the station:

1. Records `slice_submitted`, the builder's act.
2. Refuses `head_moved` unless the tip is exactly one new commit on the recorded head.
3. Refuses `check_changed` if the declared check's definition at the tip differs from the default branch's.
4. Refuses `workspace_dirty` unless the workspace is clean, so the files on disk are exactly the committed code. Then it runs the check there, and refuses `check_failed` with the output attached, or `check_rewrote` if the workspace is not clean afterwards.
5. Records `slice_committed` with the commit and the check's output, or `slice_refused` with its code, and then moves the branch back to the recorded head. A refused slice's files stay in the workspace as uncommitted changes.

A kill anywhere in this leaves the branch ahead of the record, and the next turn moves it back. A `git commit` after the turn closes lands on the branch but not in the record, and the next run takes it off.

**No hooks run in a workspace.** When it creates the workspace, the factory turns on `extensions.worktreeConfig` and writes the worktree's own config: an empty `core.hooksPath` (so neither the repo's hooks nor the user's global commit gate judge a builder's commit), `commit.gpgsign=false` (no signing with the owner's key), `gc.auto=0`, and the builder's name as the author.

**The builder's git writes** are the shared `objects/`, its own branch's ref, ref lock and reflog, `packed-refs.lock`, and the worktree's own git directory apart from its `config.worktree`. Nothing else under the shared git directory is writable, including `config`, `hooks`, `packed-refs`, `main` and every other ref. Git takes `packed-refs.lock` on every ref update and never writes `packed-refs` for a commit. The same paths are denied to the harness's edit tool. The planner and reviewer write no git data.

## Ship

Approving the Review artifact ships the order in the same process. Ships of one project take a lock in `locks/` in turn. A second approval waits for the lock, and does not fail as busy.

1. Reads how the project ships from the default branch's settings. A project that does not say is stopped with `ship_unset`.
2. Refuses `checkout_dirty` if the checkout's working tree is not clean.
3. **Rebases** the order's commits, from the recorded head, onto the default branch's tip: `git merge-tree --write-tree` then `commit-tree` for each, keeping the builder as author with the factory as committer. Nothing is touched until the rebase is known. It records `branch_rebased` with the new head, then moves the branch and resets the workspace to it.
   - **A conflict** at a commit keeps the commits before it as the new head, puts the merge of the rest into the workspace with its conflict markers, records `ship_stopped` with the paths, sends the order to build, and refuses with `ship_conflict`. The builder resolves it with an ordinary commit and `slice submit`, and nothing is replayed after it.
4. Runs the check on the rebased workspace. A failing check sends the order to build with the output, and refuses with `ship_check_failed`.
5. **Lands:** `git merge --ff-only` in the checkout if the default branch is checked out there, otherwise `update-ref` against its expected old value. Either one is the single moment the default branch moves, so it holds all of the order's commits or none.
6. Records `ship_landed` with the rebase and the check as evidence. It then removes the workspace and branch and records `cleaned_up`. What it could not remove is named in `ship_landed`'s details.

The check an order is judged by until it ships is the default branch's definition of the declared check, run on the order's code, together with the gates of the installed `dim`. A slice that changes that definition is refused. The code the check runs is the order's to change: tests are code.

## The check

The check runs the declared check task ([`src/declared-tasks.ts`](../src/declared-tasks.ts)) under an OS sandbox that allows writes only to the tree it checks and its own temp directory, with tool caches pointed at that temp directory. Its environment is the worker's list without any sign-in. Its output is evidence, capped at a size stated in the policy with its reason.

## Workspaces

A workspace is `workspaces/<owner>/<repo>/<order>/`: a git worktree of the project's checkout on the branch `dim/<order>`, made when the order first runs. It lives outside the project, so no harness sees it as nested in another checkout. A session in a workspace belongs to its project through git's common directory, not through a path segment. A project named with `--project` from outside its checkout is found through the checkout the record last saw for it.

## The trace

`trace.jsonl` in the state directory holds one line per factory step, keyed by order. `dim trace <order>` prints the order's lines and follows the file as it grows. `dim trace clear` empties it. No order state reads it.

## Record versions

The record carries its schema version as `PRAGMA user_version`. Every writer and reader refuses another version, naming the repair. `dim doctor` reads any version so it can report the mismatch, and `dim rebuild`, the repair it names, is the one writer that opens an older version: it re-derives the session tables and carries the factory's tables across.

## Commands and output

The command names are whole words with subcommands (`dim order approve`, `dim hooks install`, `dim query search`), hooks included, and that rename lands first. Bare `dim` lists the commands. The operator's: `order add|run|approve|return|update|cancel|show|clean`, `operator register`, `message send`, `session show`, `trace`. `order clean` succeeds on an order already cleaned up.

Each command prints one line of JSON. A refusal carries `code`, `message`, `meta` and `resolve`, the `dim` command that resolves it, looked up in a table keyed by every code, so a new code does not compile until it says how it is resolved.

## The wall

The wall reads the same fold through a read-only connection and shows each order's title, project, station and worker in its status column. The UI stays on [`src/wall/wall-contract.ts`](../src/wall/wall-contract.ts) until the owner asks for the wall to be adapted.

## Changes this design makes to the acceptance harness

- The harness sets the three XDG variables in place of `DIM_HOME`, writes `models.json` to the config directory in place of `routing.json`, sets `harness: claude` in the project's settings, and reads the record at `record/sessions.db`.
- The probes that plant `$DIM_HOME/planted` name the record's directory, so they still test a real path. The probe on harness config and skills targets the worker's own `HOME`.
- Tests read worker transcripts through `dim session show` instead of the owner's `~/.claude`.
- `ship` has one value: the project-over-user test uses `harness`, and the settings-from-the-default-branch test has the builder write `{}`.
- The random-kill test tolerates a second `ship_started`, since a killed ship that runs again starts again.
- The fake builder's commit act runs `git add -A && git commit -m <subject>` in its sandboxed shell, then `dim slice submit`. The fake's sandbox takes allowed paths as well as denied ones, and no longer allows the whole shared git directory.
- A slice with no subject is git's own refusal and records nothing.
- The late-work test asserts that the late commit is not recorded and that the next run takes it off the branch.
- A new test: a builder's `--amend` before submitting is refused `head_moved`, and the branch is back at the recorded head.
- `order_updated` and `branch_rebased` join the vocabulary.

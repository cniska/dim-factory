# The Factory Core

How `dim` runs an order from added to shipped. The words are the [glossary](glossary.md)'s, the requirements are the spec's, and the acceptance suite under [`acceptance/`](../acceptance/) is the contract the code is built to.

## Shape

The factory and the session record share one SQLite file and own separate tables. The factory reads the session record only through its published functions ([`design.md`](design.md) owns the record).

A factory module is made of up to five files: a rules file of pure functions, a `-contract.ts` (types, schemas, refusals), a `-store.ts` (its SQL), `-effects.ts` (git, processes, files) and `-ops.ts` (what other modules and commands call). Only `order` and `worker` have a store. A command parses arguments, calls ops and prints the result. [`src/factory-modules.test.ts`](../src/factory-modules.test.ts) enforces the boundaries.

| Module | Holds |
|---|---|
| `order` | The log, the fold that works out an order's state, and what the order admits |
| `worker` | Worker names, roles and sessions, and who a process acts as |
| `station` | Briefs, turns, the acts a worker may send, and each station's definition of done |
| `harness` | The Claude Code adapter: starting, resuming and replacing a session, and reading its stream |
| `workspace` | An order's worktree and branch |
| `slice` | The gates on a builder's commits |
| `ship` | Rebasing, checking and landing an order |
| `check` | Running the project's declared check in a sandbox |
| `trace` | Writing each factory step to the trace and following one order's steps |

## Paths

One XDG layout, resolved in [`src/paths.ts`](../src/paths.ts). A test isolates `dim` by setting the three XDG variables.

| Category | Default | Holds |
|---|---|---|
| Config | `$XDG_CONFIG_HOME/dim` | `config.json` (the user's settings) and `hooks/` |
| Data | `$XDG_DATA_HOME/dim-factory` | `record/` (the SQLite file and hook spool), `workspaces/<owner>/<repo>/<order>/`, `workers/<name>/home/` and `workers/<name>/sessions/` |
| State | `$XDG_STATE_HOME/dim-factory` | `trace.jsonl`, `locks/` and `sync.log` |

A project's settings are its committed `.dim/config.json`, layered over the user's ([`src/config.ts`](../src/config.ts)).

## The rules

- **The log is the only state.** Each order has one append-only log of typed entries, each naming who took it: a worker's session, or the factory with its version and the entry that caused it. Everything else, such as the status, the plan, the findings and what the order admits, is a fold over the log ([`src/order.ts`](../src/order.ts)). The one exception is a [run](glossary.md), a row per live process that is deleted when the process ends.
- **An order admits a set of actions.** The fold gives the actions the order accepts now and the one that moves it on. Any other action is refused, naming the set. A run already alive makes the order busy, except to a cancel of a station turn.
- **A worker writes only through its turn.** Each turn opens a Unix socket and passes its path to the worker; any connection to it acts as that worker. The worker's sandbox cannot write the record, so every work act is a request the station checks and records. Once the turn ends, nothing more is recorded for it.
- **Who acts is read from the process tree.** A command acts as the worker whose registered session is its nearest ancestor. Nothing a worker sets changes that.
- **The record wins over the branch.** The record holds the branch's head. Whenever they disagree, the factory moves the branch back and leaves the files, which refuses a bad slice, repairs after a kill and undoes a rewrite.
- **A refused act is recorded before it is raised.** A refused slice, ship or message is logged as a [stop](glossary.md) holding its code and the facts behind it, and the refusal carries the order plus those same facts ([`src/order-ops.ts`](../src/order-ops.ts) `recordStop`).
- **What needs no judgement repairs itself.** A run whose process is gone is cleared at the next run: its harness is killed, its session resumed or replaced, a submitted slice judged, a commit the record lacks taken off the branch, an interrupted ship run again.

## Turns

A turn resumes or replaces the worker's session, spawns the harness with a brief or a message, serves the acts the worker sends, and copies the transcript when the process ends.

- **A station turn** starts from the station's brief: JSON with fixed keys holding facts and naming the station's skill ([`src/station.ts`](../src/station.ts) `briefAt`). It ends when the worker's return meets the station's definition of done; a return that misses it twice fails the station.
- **A message turn** starts from the operator's message, may only read, and its final text is the reply.
- **A dead session** is replaced by forking the factory's copy of its transcript, so the new session holds everything the old one did.

## Starting a worker

[`src/harness-claude.ts`](../src/harness-claude.ts) builds the `claude -p` command line. A station worker gets:

- **Its own `HOME`**, so nothing of the owner's home or settings reaches it, and the factory's skills through `--plugin-dir`.
- **A listed environment** ([`src/station.ts`](../src/station.ts) `workerEnv`): the owner's git identity, its own turn's temp directory (passed as `CLAUDE_CODE_TMPDIR` too, since Claude's sandboxed Bash takes `$TMPDIR` from it), and only the sign-in its harness needs.
- **A sandbox**: the builder writes its workspace and turn directory; the planner and reviewer write only the turn directory. The record, the factory and every harness config are out of reach. The checkout's git hooks are denied, and a changed git config is put back and fails the station.
- **The model** its role's entry in the user's `models` setting names.

## Skills

A skill under [`skills/`](../skills) is one the owner or a worker invokes by name. What only one skill reads sits in that skill's folder: inline, since a worker reads a skill it loads and sometimes skips what it links, or in its own `references/` when the skill hands it to its agents. What several skills read is one file in `skills/references/`, linked from each skill's own `references/` folder.

## Slices

The builder commits with plain `git commit` and hands the commit in with `dim slice submit`. The station keeps it only if it is one new commit on the recorded head, leaves the check's definition unchanged, and passes the check in a clean workspace ([`src/slice.ts`](../src/slice.ts)). A refused slice's files stay in the workspace.

A check runs in its own process group with a 10-minute limit ([`src/check.ts`](../src/check.ts)). A check that reaches the limit is stopped and fails, its output saying so, and nothing a check started outlives it.

## Ship

Approving the Review artifact ships the order, one ship per project at a time:

```text
rebase onto the default branch → check → land (fast-forward) → remove the worktree and branch
  | conflict or failing check → back to build
```

The rebase runs under the owner's git config, so the landed commits are signed when the owner's are. Landing is one ref move, so the default branch holds all of the order's commits or none ([`src/ship-ops.ts`](../src/ship-ops.ts)).

## Workspaces

A workspace is a linked worktree of the project's checkout on the branch `dim/<order>`, outside the project. Before each station turn the factory installs the project's dependencies there from its lockfile, in the check's sandbox. Cancelling removes it and its branch.

## The trace

Every effect the factory runs on its own, and every log append, is a step of the run's trace ([`src/trace-ops.ts`](../src/trace-ops.ts)). A run, cancel included, makes its trace before anything else, keyed by order and process, and passes it to every effect, so an effect cannot be called untraced. Everything the run does is under its `run` step, and its first step records the act that started it and names the log entry that caused the run. Each step writes a `started` line with its fields and an `ended` line with its time, outcome and result to `trace.jsonl` in the state directory; the steps and their fields are a closed list ([`src/trace-contract.ts`](../src/trace-contract.ts)). A failed write fails the step. `dim trace <order>` prints one order's lines and ends once the order has no live run and no new lines. Nothing reads the trace for state, so deleting `trace.jsonl` changes nothing else.

A run that hangs ends in a `started` line with no `ended`, naming what it waits on; a failed run shows which step refused and with what code.

## Record versions

The record carries one schema version as `PRAGMA user_version`, covering the factory's tables with the record's. Every reader and writer refuses another version, naming `dim rebuild` as the repair; `dim doctor` reports a mismatch. While orders are disposable, `dim rebuild` resets the factory: its workers, sessions, logs and runs are dropped and recreated empty.

## Design rule

Every fact about an order lives in one log, and every decision is a pure function of it. What a worker may do is enforced by how it is started, never asked of it, so the factory trusts the record and the sandbox rather than the worker.

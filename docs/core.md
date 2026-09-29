# Factory core design

**Status: approved by the owner; built in slices.**

This is the target design for the factory core: the `order`, `station`, `worker`, `ship` and `factory` modules. It is built in place on `main`, in vertical slices. Each slice replaces one mechanism, and deletes the old one in the same commit, so no commit runs two behaviors. What the core does stays as [`SPEC.md`](../SPEC.md), [`factory.md`](factory.md) and the integration tests state it, except where a change below says otherwise; that SPEC, doc or test edit lands in the change's own commit. The record, ingest, queries, gates, harness adapters and the wall stay. They move to the new core in the slice that changes what they read.

The rules behind every choice here are the owner's design standard (the `design-review` skill).

## Why

More fixes land in the core than anywhere else, and its designs multiply, because each agent copies the shape it finds:

- **Two admission systems.** `assertNext` decides which act is next, and `assert*` calls inside writers decide it again (`assertOrderRunning`, `assertNoRunningAttempt`, `assertOrderQueued`, `assertChecked`), beside the `assertOperator` calls.
- **Rows used as the model.** `StoredArtifact` has nullable `headSha` and `reviewId` for every kind, and callers cast them back (`order-state.ts:51,61`).
- **A dozen error classes in the core, each shaped differently,** plus a hundred naked `throw new Error(`.
- **SQL in every layer:** in `order-*`, `station-*` and `worker*`, and in the wall and several command files.
- **The same rule written several times.** The approval rule exists in three SQL copies, and claim-and-fail in three station copies.
- **Writers that return an id,** which most callers ignore and a few read back.

## Layout

Files stay flat by module prefix, and `wall/` stays the only folder. A module has up to four kinds of file, and has a kind only where it holds that concern:

| File | Holds | May import |
|---|---|---|
| `<m>-contract.ts` | types, error codes with their fact shapes, and the parsers for stored JSON | other contracts |
| `<m>-store.ts` | every query and transaction of the module, and the mapping between rows and model | contracts, `db` |
| `<m>.ts` | the model and its rules: pure functions and commands | contracts, its own store, other modules' `<m>.ts`, never another module's store |
| `<m>-command.ts` | CLI parsing and printing | contracts, `<m>.ts` |

A module's public API is its `<m>.ts` and `<m>-contract.ts`. Other modules import only those two, and the store and every other file stay internal to the module, with no barrel file. UI → business → persistence, and nothing skips a layer. A command never imports a store. Config and the environment are read only at the composition roots (`cli.ts` and the wall's server) and passed down as typed parameters; the core reads no `process.env`.

SQLite stays behind the stores. A store owns its transactions: one store function loads, lets the rule decide, and writes, so no caller opens `writeTransaction` itself, and no `json_extract` or `RETURNING` contract reaches past a store.

## The order aggregate

The order is the aggregate root. Its events, artifacts, slices, attempts, findings, answers, commits, checks, proofs and ship runs belong to it, and they are deleted with it.

- **The model holds what its rules read.** `loadOrder(db, id)` in `order-store.ts` reads one order into an `Order`:
  - for a check, its head and exit code;
  - for an artifact, its id, kind, revision, head and review;
  - for a finding, its answer.

  Bodies, check output and proof output are not part of it. A brief or the wall's item view reads them when it shows them.
- **Reads that list orders use a projection.** The wall's one-second poll and `q factory` read a read-only projection the order store provides through `order.ts`, never the whole aggregate per order, and keep the read-only open the wall uses today.
- **State is a pure fold.** `next(order)` in `order.ts` returns the one next act: `plan`, `build`, `review`, `approve` with its station, or `ship`, or none once the order is shipped or dropped. That is one `OrderAct` type. `NextAct`, the station/run pair and the `ENTERS` table go.
- **Rules read the model, not the database.** The approval rule ("approved, not returned, latest revision, after the plan it builds on") becomes one function over `order.artifacts`, with no SQL. Its three copies go, and so does `order-approved-plan.ts`.
- **One admission, inside the write.** `admit(order, act, actor)` holds every refusal an act can meet:
  - not next;
  - terminal;
  - held by a running attempt;
  - the wrong role;
  - a missing reason;
  - no passing check at the head;
  - a pending rebase conflict.

  The store loads the order, `admit` decides, and the event is appended, all in one immediate transaction. `assertOrderRunning`, `assertOrderQueued`, `assertNoRunningAttempt`, `assertChecked`, `assertOperator` and `OrderNotDone` go.
- **A station holds its order from admission until its attempt is recorded.** A worker's name and session exist only once its process has started, so the attempt cannot be written before the launch. A station takes the order's lock in the data directory (`holdOrder` in `station-attempt.ts`), admits, launches, and lets go once the attempt is recorded or the launch ends. A second station on the order meets the lock while the first is starting and the running attempt once it has, and is refused either way. A command that dies holding the lock leaves a dead pid, and the next claim clears it. `admit` is the only place a running attempt refuses an act.
- **The actor carries its role.** `admit` takes a `Worker { name, role }` from the worker store and refuses by role, per act:
  - the operator: queue, start, approve, return, drop, ship and delegation;
  - the builder: answers;
  - the round's reviewer: findings.
- **Commands return the model.** `queue`, `start`, `approve`, `return`, `drop`, `ship` and the evidence writers append through the store, which reloads the order inside the same transaction and returns the updated `Order`.

## Record and model

- **Rows stay in the store.** The `*Row` types are private to `order-store.ts`, and one mapping turns rows into the model.
- **Events keep their columns and take a typed union.**
  - **Table:** `factory_order_event` keeps a column per field, so the fields stay queryable and `station` keeps its `CHECK`. The dead `check_id` and `review_id` go; `evidence` goes with `provenance` in the cuts.
  - **Actor:** a worker's act names its worker; the factory's own acts name none and read as `factory` in the log. The factory's acts are a station failure and the check, proof and ship run evidence, which stay visible beside the ledger. A commit is the builder's act (see Commits).
  - **Type:** `OrderEvent` in `order-contract.ts` is a union keyed on `kind`, and each kind states its fields and whether a worker writes it, so an event missing its worker, station or reason does not compile.
- **Artifacts are a union.** `Plan { slices } | Build { headSha } | Review { reviewId, headSha }`, keyed on `kind`, matching the table's own CHECKs. The `as string` casts go.

## Errors

- **One base.** `CodedError<Code, Meta>(code, message, { meta, cause })` in `coded-error.ts` keeps the original error as `cause`.
- **Codes per module,** as an `as const` map in its contract, with a fact shape for each code. For example, `order.act_not_next` carries `{ orderId, act, next }`.
- **One constructor per module,** `fail(code, meta)`, which builds the message from the code and its facts. A throw site passes facts, never a finished sentence.
- **A message is written for the model that reads it:** what was refused, the fact that caused it, and the command that resolves it, built from the same facts, or that nothing does.
- **The message map is the code list.** A module's contract holds one map from each code to the function that words it from its facts, so a code cannot exist without its message. `cli-output.ts` prints every coded error the same way, with its code, message and facts. An error that is not a domain code — a database, configuration or programming failure — keeps one explicit unexpected-failure path there.
- **What folds in:** the core's error classes (`OrderActRefused`, `OrderNotDone`, `OperatorActionRefused`, `ShipRefusal`, `RebaseConflict`, `FactoryStopError`, `UsageLimited`, `ReviewRefused`, `ReviewNotOpen`, `BuildTurnRefused`, `WorkerUnknown`, `WorkerSessionTaken`, `WorkerAssignmentError` and `RoutingError`) and its naked throws, each moved in the slice that rewrites the path it sits on.
- **Where a catch is allowed.** Below the CLI, a catch may do only two things. It may undo a side effect on git, the worktree or a worker binding, or record evidence, and then rethrow the same error. Or, in a store, it may translate a SQLite constraint into its module's code. The compensations that do this stay: `restoreBranch`, `abortRebase`, the soft reset of a refused commit, the rebase recovery and the worker release.

## Stations

- **One station run.** `runStation(db, orderId, station, operator, options)` in `station.ts` owns the order's hold, admission, the attempt's start and the failure event; the worker's turn (`runWorkerTurn` in `station-worker.ts`) releases the worker when it fails. A station supplies two things:
  - `prepare(db, order, launch)`, which returns its brief, the context `accept` reads, and an `abort` that undoes what it opened, such as review's round, if the run fails;
  - `accept(db, output, turn, context)`, where `turn.resume(brief)` runs another turn of the same attempt. Build uses it for rebase-continue and commit corrections, which come back from the commit as a value, not a throw.

  Each `accept` ends in one store write that also finishes the attempt, so a kill never leaves recorded work under an open attempt. A usage limit finishes the attempt `limited` and writes no failure event.
- **Worker binding in one place.** The worker row keeps its fixed `session_id`, its bound `harness`, and a `provider_session_id` that is rebound on every turn. The copy on the order side, the `coalesce` that reconciles the two, and the second release path go. A worker bound to one harness is still refused under another.
- **Review reads the whole order,** from the order's fork point with the trunk to its head, on every round.
- **The build runner keeps its gates:** answers, comments, named tests, proof, the declared check, and the commit. It stops re-checking its own writes (`requireBuildEvidence` goes).

## Commits

The runner is the only committer, because NF-6 keeps every worker out of the git directory, and the commit's hooks and identity are the runner's to control. It commits first and judges the commit, rather than judging an uncommitted tree:

1. stage the slice; refuse a `.gitattributes` change, an added comment, and a missing or untouched named test;
2. commit it on the order's branch, with hooks outside the tree, so the subject gate runs before anything expensive;
3. run the proof against that commit's parent, then the declared check in the sandbox;
4. on any refusal, reset the order's branch to where it was and leave the slice uncommitted in the worktree. Nothing is recorded until every gate passes.

A build that finds the order's branch one commit past its recorded head, with that commit's parent recorded, resets it the same way before the builder starts: a judgement was interrupted. The proof pin, `settlePinnedSlice`, its trace events and its cleanup in `wt` and ship go. FR-12 and AC-18 say "kept on the order's branch" where they say "committed".

A fix order's failing test lands in the same slice as its fix, so its proof is taken at that slice's base. A later turn that adds only a test for an earlier fix is refused like any fix slice whose tests pass at its base.

**Identity.** A factory commit is the owner's work made by an agent: the author is the repo's identity, the committer is the factory (`dim`), and it is not signed. The order record names the builder. A session the owner directs keeps the repo's own signing. Signing at landing stays possible later; nothing here blocks it. `refuseUnsigned` and its `docs/factory.md` line go.

## Worker, ship and factory

These modules keep what they do, and take the layout above only where they hold the concern.

- **`worker`:** identity from the process tree and the runner barrier, both unchanged; assignment, routing and the process environment (`worker-process-environment.ts`). Capabilities shrink to the one that is read, `edits: boolean`.
- **`ship`:** the rebase and the landing, under the factory lock and the runner barrier. Every ship still writes one ship run, whatever its outcome, through an `order.ts` command. An unclassified failure is recorded with its code, not as a `refused` run with no code.
- **`factory`:** the operator role check, until `admit` holds every order act and `factory-operator.ts` folds into the worker contract.
- **Disposable processes.** A killed worker loses nothing the record does not hold, and that is the test for every piece of recovery machinery.

## Cuts

Each cut lands with the SPEC, doc, glossary, query and skill edits it carries.

- **`amend`,** which writes no event. This edits FR-11, AC-14 and the `factory.md` command list.
- **`ready` with `--limit`, `priority`, and the `priority` column.** This edits FR-11, AC-14, `factory.md`'s commands, the glossary, `q order`'s evidence column and `q factory`'s `priority` column, and removes `order-ready.ts`.
- **`provenance`:** `queueOrder` writes it into the queued event, but no caller supplies one. Its field, its write and its test go.
- **Fields nothing writes:** the dead event columns, and the attempt outcomes `timed_out`, `stalled` and `cancelled`.
- **The `feat` default for `line`,** which makes `--line` required. This edits `factory.md`'s `add` line.
- **Duplicates:** `OrderStationName` (it is `Station`), the ship tests repeated in `order.test.ts`, and the schema-text tests.
- **Fallbacks:** the "worktree it chose" branch of `stationDirectory`, the brief's "could not be read" lines, the commit-convention section of the brief (the gate holds the subject), and the `finishAttempt` no-op.
- **The proof pin and commit signing,** as Commits says.

**Kept on purpose:**
- `--project`, which `dim-add` passes.
- `hooksOutsideTree`, which stops a builder editing a hook the runner executes.

## Todo entries this closes

- **Bugs:**
  - a returned plan strands a pending rebase conflict, since the pending conflict is a fact `admit` reads;
  - a refused finding cannot be raised again, since review reads the whole order;
  - a test added after its fix is proved against the fix, since a fix's test lands with its fix.
- **Debt:**
  - one claim-and-fail path;
  - orchestration out of `order-command.ts`;
  - the core's part of "one git runner, one clock".
- **Features:**
  - order worker assignment cleanup;
  - order table cleanup, in part: the dead event columns go, and the entry keeps the rest.

## Slices

Each slice runs on `main` and deletes the old mechanism in the same commit. `bun run verify` gates every slice, and a slice that changes a behavior the tests pin names those tests and changes them in the same commit. The schema slices run with no order in flight.

1. **Errors.** `coded-error.ts`, the order module's message map and `fail(code, meta)`, and coded errors printed with their facts by `cli-output.ts`, replacing `OrderNotDone` and `OrderActRefused`. Each later slice moves the throws on the paths it rewrites.
2. **Admission.** The `Order` model, `loadOrder`, `next`, `admit` and the station's hold on its order replace `orderState`, `assertNext`, `ENTERS` and the `assert*` calls, with admission inside the write.
3. **Events** [schema]. `OrderEvent` as a union keyed on `kind`; the dead `check_id` and `review_id` columns go.
4. **Commits.** Commit first, judge, reset on refusal; the proof pin and signing go.
5. **Station run.** `runStation`, then plan, review and build in turn; review reads the whole order.
6. **Worker binding** [schema].
7. **Ship.** Ship runs through an `order.ts` command.
8. **Cuts,** each with its SPEC and doc edits.

Factory data is disposable, so a schema slice needs no migration. `factory:reset` clears orders only in a named data directory, so on the default record a schema slice lists every column it drops in `DISCARDED_COLUMNS`, or the orders are cleared by hand before `dim rebuild`.

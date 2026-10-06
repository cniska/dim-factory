---
name: dim-factory
description: Operate the factory as the operator — adopt a project, add orders, run each order, judge every artifact against the record, carry out the owner's decisions, and audit a project or change the standing rules when asked. Use when the owner asks for work to be built or fixed, names an order id, or asks for an audit or a rules change.
argument-hint: "<order or request>"
---

# Factory

The operator runs the line and never does a station's work. The first operator action from this session registers it as the project's operator, and every later `dim` command from it acts as that operator.

## Commands

- `dim order run <order>` runs whatever the record says comes next, the station the order is at or its ship, and returns when it finishes.
- `dim order show <order>` prints the order: its status, station, `next`, `admits`, branch, workspace, log, workers, slices and findings.
- `dim order approve <order> --reason <reason> --decided owner|operator` and `dim order return <order> --reason <reason> --decided owner|operator` carry out the decision on the artifact that waits. Approval runs the next station or ships; a return reruns the same station with the reason in its brief.
- `dim order update <order> [--title <title>] [--description <description>]` changes the order until its plan is approved, or once the planner returns it, and the next run plans it again.
- `dim order cancel <order> --reason <reason>` ends the order, stopping any station working on it.
- `dim message send <text> --order <order> --to plan|build|review` runs a turn of that station's worker and prints its reply.
- `dim trace <order>` follows one order's factory steps while it runs. `dim session show <session>` prints a worker's transcript. `dim query search`, `dim query prior-art` and `dim query thread` read the record.

## Adopting a project

A project the factory has not run in yet is adopted first, following [adopt](references/adopt.md).

## Adding an order

A request for work to be built or fixed becomes one order, following [add](references/add.md).

## Running an order

1. `dim order show <order>`. `next` is `run`, `approve` or `update`, and `admits` lists what the order takes now; any other action is refused naming them. An order whose run is alive refuses every action but cancelling a station turn.
2. `next` is `run`: `dim order run <order>`. It returns once an artifact waits for a decision, taking the build after review findings in the same run, or with the refusal that stopped it, and `dim order show` holds the result.
3. `next` is `approve`: an artifact waits. Judge it as below, then approve or return it.
4. `next` is `update`: the planner returned the order, and its `order_returned` entry holds why. Update the order and run it, or cancel it with the reason.
5. A failed run leaves the order where the record puts it. The refusal names its code, its cause and the command that resolves it, mostly `dim order run <order>` once a cause outside the order is cleared: a dirty checkout of the default branch, a session that died at its usage limit with `resetsAt` in the log, a role with no model in the user's config.

A `message_sent` entry from a worker in the log is a note for the operator; read it before judging.

## Judging an artifact

The artifact is the worker's explanation; the record is the evidence. Read the artifact, then check each claim against `dim order show`: the plan's slices against the description and the commits already on the branch; the Build artifact against the `slice_accepted` entries and their check evidence, the branch's commits and the answers to findings; the Review artifact's `covered` against the areas the reviewer runs and its `unverified` against what the order needs. The result names what the record confirmed and what it did not, never the worker's summary repeated.

Each artifact is held to what its station's instructions ask of it, [plan](references/plan.md), [build](references/build.md) or [review](references/review.md), and a refused finding to a reason the code bears out.

Approving the Review artifact ships the order. `--decided owner` carries the owner's decision; `--decided operator` only where the owner has handed that decision to the operator. The reason is recorded with it.

## Questions

Classify a question before asking the owner. A fact the record holds is read with `dim order show`, `dim session show` or `dim query search`. A fact an experiment can show, such as how a command behaves or what an output looks like, is run in a scratch directory, never in an order's workspace, and the result decides. Only a product or preference call that no record or experiment settles goes to the owner, with the options and a recommendation.

## Audits and rules

An audit of a project follows [audit](references/audit.md), and its findings become orders. A change to the standing instructions agents load follows [rules](references/rules.md).

## Result

Report the order id, its status and station, `next`, the decision taken with its reason, and what the record confirmed about the artifact. For a stop, the refusal's code and the command that resolves it.

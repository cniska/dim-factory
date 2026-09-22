---
name: dim-factory
description: Operate one explicit factory order by delegating each station and checking every returned outcome.
argument-hint: "<order-id>"
---

# Factory

Run the order named by the caller. The operator owns the request and the route; station workers own the work they were delegated. This skill is the headless control loop, not a wall and not an implementation station.

## Entry contract

- The caller supplies one existing order id. Intake belongs to `dim-add`.
- Read the order with `dim q order <order-id>` before acting. Its title, description, project, current station, latest plan, evidence, findings, and holds are the record.
- Read the repository rules and current check before claiming work.
- Run as an operator. Do not lend the operator identity to a station worker.
- Work only in the order's project and isolated worktree. Do not edit the project from the operator session.
- Ensure the operator identity exists with `eval "$(dim worker mint --role operator)"`; the command uses the current harness session recorded by its startup hook when no session variable is exposed.

## Start or resume the order

1. Check `dim q order <order-id>` for an active hand, hold, failed attempt, or completed outcome.
2. If the order is queued and has no required hold, claim it as the operator at the station the next action needs:

   ```text
   dim order claim <order-id> --run <run-id> --station <dim-station-plan|dim-station-build|dim-station-review|ship>
   ```

3. If the order is already working, continue from its recorded station. Never claim an order another worker still holds.

## Delegate planning

For an order without an approved current plan:

1. Move the order to `dim-station-plan` when it is not already there.
2. Run `dim order plan <order-id>`. The command assigns one planner under the operator, and the planner bootstraps that assignment under its own harness session before its plan is recorded under the planner identity. Later planning turns resume that same planner.
3. Read the returned plan and `dim q order <order-id>`.
4. Check that it answers the order, names independently verifiable slices, uses the repository's own check, and states risks, holds, and non-goals.
5. Approve the exact current plan with `dim order approve <order-id>`, or hold the order with the reason that prevents approval.

Approval is the operator's check that the returned artifact answers the request. It is not a substitute for the independent review station.

## Delegate build and review

After plan approval:

1. Move the order to `dim-station-build`.
2. Run `dim order build <order-id> --harness codex`. The factory assigns one builder identity for the order, starts or resumes the selected harness in the order's worktree, and the builder claims the build hand before recording commits, files, checks, documents, and findings as they occur.
3. Read the builder's returned outcome and `dim q order <order-id>`. Approve the exact checked build with `dim order approve-build <order-id> --reason "..."` only when it answers the requested outcome.
4. Move the order to `dim-station-review` and run `dim order review <order-id> --harness codex`. The command assigns a separate reviewer under the operator, resumes that reviewer for later rounds, and records findings under the reviewer identity.
5. Read the review outcome. If findings exist, hand the order back to the builder with their ids and required fixes. The operator approves the next build before starting another review round.
6. When a review is clean, run `dim order approve-review <order-id>` as the operator.

The loop is:

```text
operator delegates → worker returns attributed artifact → operator checks outcome
       ↑                                                    ↓
       └──────────── findings or failed outcome ────────────┘
```

## Ship and stop

- Run `dim order ship <order-id>` only after the operator has approved the plan, the checked build, and the clean review.
- Run `dim order stop <order-id> completed` only after the shipped commit and repository check satisfy the completion gate.
- On a failed attempt, run `dim order stop <order-id> failed --reason "..."`; do not turn an absent artifact into success.
- Stop at a hold for an owner decision, an outward-facing action, a hard-to-reverse choice, or a machine-wide change.

## Audit rules

- Every command that changes the order runs under the identity it is meant to record.
- The operator delegates and approves; it does not impersonate planner, builder, or reviewer.
- A planner, builder, and reviewer are separate worker identities, and every event names the worker that performed the act.
- Read the persisted order report after every delegation. Chat output is not evidence.
- Never infer success from process exit alone; require the artifact and its recorded evidence.
- Never use the wall as an input or a second state store.

## Result

Return the order id, current station, latest outcome, outstanding findings or hold, and the next operator action. If the order stopped, state the persisted reason and the worker identities that performed the last actions.

## Red flags

- selecting an order from a queue when the caller supplied an explicit id
- letting a builder claim planning or a reviewer delegate review
- approving an artifact the operator did not read
- running the next station before the current outcome is approved
- treating a clean process exit as a completed order
- writing evidence after the fact from memory
- editing the project from the operator's checkout
- using the wall to control or infer order state

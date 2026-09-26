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
- Ensure the operator identity exists with `eval "$(dim operator)"`; the command resolves the sole active operator session from its startup hook.

## Start or resume the order

1. Check `dim q order <order-id>` for an active hand, hold, failed attempt, or completed outcome.
2. If the order is queued and has no required hold, claim it as the operator at the station the next action needs:

   ```text
   dim order claim <order-id> --run <run-id> --station <plan|build|review>
   ```

3. If the order is already working, continue from its recorded station. Never claim an order another worker still holds.

## Delegate planning

For an order without an approved current plan:

1. Move the order to `plan` with `dim order move <order-id> --station plan` when it is not already there.
2. Run `dim order plan <order-id>`. A station command runs its worker under your own harness; add `--harness <codex|claude>` to run it under the other, and a station worker stays on the harness it started under. The command assigns one planner under the operator, and the planner bootstraps that assignment under its own harness session before its plan is recorded under the planner identity. Later planning turns reuse that same planner identity.
3. Read the returned Plan artifact and `dim q order <order-id>`.
4. Check that it answers the order, names independently verifiable slices, uses the repository's own check, and states risks, holds, and non-goals.
5. Approve the exact current Plan artifact with `dim order approve <order-id>`, or return it to the same planner with `dim order return <order-id> --reason "..."`.

Approval is the operator's check that the returned artifact answers the request. It is not a substitute for the independent review station.

## Delegate build and review

After plan approval:

1. Move the order to `build`.
2. Run `dim order build <order-id>`. The factory assigns one builder identity for the order, starts the selected harness in the order's worktree, and records documents and findings under that builder as they occur. After each turn that does code work, the runner runs the declared check in the check sandbox, commits the worktree the way your git config commits, records the commit and its files under the builder and the check under you, and fails the attempt with the check's output when it is red.
3. Read the builder's returned evidence and `dim q order <order-id>`. Intermediate slices move directly to review after their passing check; they do not wait for owner approval. After the final slice, read the single Build artifact for the whole order. Approve it with `dim order approve <order-id> --reason "..."` or return it to the same builder with `dim order return <order-id> --reason "..."`.
4. Move the order to `review` and run `dim order review <order-id>`. The factory creates the reviewer identity and resumes its provider session on later rounds. A clean intermediate review returns to build automatically; only the completed build is held for owner approval.
5. Read the Review artifact; its verdict says which of these follows. When it returns to the builder — a new finding, an earlier one ruled `not_addressed`, or an overturned refusal — move the order back to `build` and run `dim order build <order-id>`; the builder answers each such finding in its turn, and the runner records the answers under it, so no finding is answered by you. When it is held for an owner ruling, show the owner both positions on each contested refusal and record their word with `dim order rule <finding-id> --uphold|--overturn --reason "..."`. If the Review artifact of a round that raised nothing needs revision, return it to the same reviewer with `dim order return <order-id> --reason "..."`.
6. Approve the current Review artifact with `dim order approve <order-id>` as the operator. Approval is refused with `finding_unsettled` while any finding is open and with `ruling_pending` while a contested refusal waits on the owner.

Every station has the same control boundary: read the worker's returned artifact, check it against persisted evidence, then approve it or return it to that worker with feedback. A return does not change the station identity or erase the earlier artifact revision. The artifact is the explanation; the evidence is the source of truth.

The loop is:

```text
operator delegates → worker returns attributed artifact → operator checks outcome
       ↑                                                    ↓
       └──────────── findings or failed outcome ────────────┘
```

## Ship and stop

- Run `dim order ship <order-id>` once the plan, the final Build artifact and the clean review are approved; it refuses with `plan_not_approved`, `build_not_final`, `build_not_approved` or `review_not_approved` otherwise.
- Run `dim order stop <order-id> completed` only after the shipped commit and repository check satisfy the completion gate.
- A station runner records a failed attempt itself. When a runner has stopped and left a claimed order behind, the operator records recovery with `dim order stop <order-id> failed --reason "..."`; this writes the worker's failed outcome and the operator's recovery separately.
- Stop at a hold for an owner decision, an outward-facing action, a hard-to-reverse choice, or a machine-wide change.

## Audit rules

- Every command that changes the order runs under the identity it is meant to record.
- The operator delegates and approves; it does not impersonate planner, builder, or reviewer.
- A planner, builder, and reviewer are separate worker identities, and every event names the worker that performed the act.
- Read the persisted order report after every delegation. Chat output is not evidence.
- Never infer success from process exit alone; require the station artifact and its recorded evidence.
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

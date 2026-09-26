---
name: dim-factory
description: Operate one explicit factory order by delegating each station and checking every returned outcome.
argument-hint: "<order-id>"
---

# Factory

Run the order named by the caller. The operator owns the request and the route; station workers own the work they were delegated. This skill is the headless control loop, not a wall and not an implementation station.

## Entry contract

- The caller supplies one existing order id. Intake belongs to `dim-add`.
- Read the order with `dim q order <order-id>` before acting. Its title, description, project, next act, latest plan, evidence, and findings are the record.
- Read the repository rules and current check before starting work.
- Run as an operator. Do not lend the operator identity to a station worker.
- Work only in the order's project and isolated worktree. Do not edit the project from the operator session.
- Ensure the operator identity exists with `eval "$(dim operator)"`; the command resolves the sole active operator session from its startup hook.

## Start or resume the order

1. Read the next act from `dim q order <order-id>`: the station and whether it waits on a run or an approval, or that the order is ready to ship. The record sets it; no command moves an order.
2. Run the command for that act. Each checks on entry that it is the act the record waits on and refuses with `not_next` otherwise, naming the act that is. `dim order plan` on a queued order starts it and makes its worktree.
3. A failed run leaves the order where it was: read the failure in `dim q order` and run the same command again. A build refuses while another build attempt on the order is still running.

## Delegate planning

For an order without an approved current plan:

1. Run `dim order plan <order-id>`. A station command runs its worker under your own harness; add `--harness <codex|claude>` to run it under the other, and a station worker stays on the harness it started under. The command assigns one planner under the operator, and the planner bootstraps that assignment under its own harness session before its plan is recorded under the planner identity. Later planning turns reuse that same planner identity.
2. Read the returned Plan artifact and `dim q order <order-id>`.
3. Check that it answers the order, names independently verifiable slices, uses the repository's own check, and states risks, owner decisions, and non-goals.
4. Approve the exact current Plan artifact with `dim order approve <order-id>`, or return it to the same planner with `dim order return <order-id> --reason "..."`.

Approval is the operator's check that the returned artifact answers the request. It is not a substitute for the independent review station.

## Delegate build and review

After plan approval:

1. Run `dim order build <order-id>` once per slice, reading `dim q order <order-id>` after each. The factory assigns one builder identity for the order, starts the selected harness in the order's worktree, and records documents and findings under that builder as they occur. After each turn that does code work, the runner runs the declared check in the check sandbox, commits the worktree the way your git config commits, records the commit and its files under the builder and the check under you, and fails the attempt with the check's output when it is red.
2. After the final slice, read the single Build artifact for the whole order. Approve it with `dim order approve <order-id> --reason "..."` or return it to the same builder with `dim order return <order-id> --reason "..."`.
3. Run `dim order review <order-id>`. The review reads the whole order. The factory creates the reviewer identity and resumes its provider session on later rounds.
4. Read the Review artifact; its verdict says which of these follows. When the round raised findings, run `dim order build <order-id>`; the builder answers each one in its turn, and the runner records the answers under it, so no finding is answered by you. The next review round reads those answers. If the Review artifact of a round that raised nothing needs revision, return it to the same reviewer with `dim order return <order-id> --reason "..."`.
5. Approve the current Review artifact with `dim order approve <order-id>` as the operator. The approval ships the order.

Every station has the same control boundary: read the worker's returned artifact, check it against persisted evidence, then approve it or return it to that worker with feedback. A return does not change the station identity or erase the earlier artifact revision. The artifact is the explanation; the evidence is the source of truth.

The loop is:

```text
operator delegates → worker returns attributed artifact → operator checks outcome
       ↑                                                    ↓
       └──────────── findings or failed outcome ────────────┘
```

## Ship

- Approving the Review artifact ships the order: its commits land on the local trunk, the order is done, and its worktree is removed. Nothing is pushed.
- A ship that does not land says why in `dim q order`. A conflict or a red check at the rebased head goes back to build and a changed patch back to review, where the next act says so. When the next act is still ship, fix what the refusal names, such as a dirty trunk checkout, and run `dim order ship <order-id>`.
- A station runner records a failed attempt itself, and the same station command runs it again.
- Stop for an owner decision, an outward-facing action, a hard-to-reverse choice, or a machine-wide change.

## Audit rules

- Every command that changes the order runs under the identity it is meant to record.
- The operator delegates and approves; it does not impersonate planner, builder, or reviewer.
- A planner, builder, and reviewer are separate worker identities, and every event names the worker that performed the act.
- Read the persisted order report after every delegation. Chat output is not evidence.
- Never infer success from process exit alone; require the station artifact and its recorded evidence.
- Never use the wall as an input or a second state store.

## Result

Return the order id, its next act, latest outcome, outstanding findings, and the next operator action. If an attempt or a ship failed, or the order was dropped, state the persisted reason and the worker identities that performed the last actions.

## Red flags

- selecting an order from a queue when the caller supplied an explicit id
- letting a builder run planning or a reviewer delegate review
- approving an artifact the operator did not read
- running the next station before the current outcome is approved
- treating a clean process exit as a shipped order
- writing evidence after the fact from memory
- editing the project from the operator's checkout
- using the wall to control or infer order state

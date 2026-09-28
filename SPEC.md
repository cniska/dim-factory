# dim-factory Specification

> A software factory run by coding agents, with the owner at the gates that still earn one.

This document states what must hold, not how. [`docs/`](docs/) explains how each part works and why.

## 1. Orders

- **FR-1** — An order whose commits landed on the local default branch is recorded as shipped, whether or not its worktree and branch could be removed.
- **FR-2** — An order is held only while one of its artifacts awaits approval. In every other state its next act is one the operator can run.
- **FR-3** — An order's history holds only the acts its workers took, each naming its worker. A station that fails before its worker exists is the one act that names none.
- **FR-4** — What the factory itself records about an order — its checks, its changed files, its worktree's setup, and each ship's rebase, landing or refusal — is evidence beside the history, never an act in it.

## 2. Stations

- **FR-5** — Every station brief names the order's line, save a build turn that resolves a rebase conflict.
- **FR-6** — A station skill routes on the line it is briefed with: a `fix` order's station runs `dim-fix`'s part for that station, and a `feat` order's never does.
- **FR-7** — A station brief carries only what its station skill cannot know — the order's data and the turn's state — and names that skill. The station's procedure is the skill's.

## 3. Workers

- **FR-8** — A `dim` command acts as the nearest registered process above it, matched on its pid and its start time. No file or variable a worker can read grants an identity.
- **FR-9** — What a running station command spawns before its worker is registered acts as no one, never as the operator above it.
- **FR-10** — A worker and a check start from an environment of named variables, never the owner's. The check gets no credential; a worker gets only the sign-in its own harness declares.

## 4. Hooks and reads

- **NF-1** — A hook a coding-agent session runs exits 0 whatever happens.
- **NF-2** — A git hook `dim` installs exits non-zero only to refuse a commit or push it has read and understood; anything it cannot read lets the commit or push through.
- **NF-3** — A reader cannot change the record it reads: a query, `dim sql`, `dim stats` and the wall fail on any write rather than make it.
- **NF-4** — A reader refuses a record built by another schema version before it reads anything from it, save `dim doctor`, which reports the drift and its repair.

## 5. Acceptance criteria

- **AC-1** — Shipping an order whose worktree cannot be removed lands its commits, records it shipped, and names the kept worktree and branch with their reasons. (FR-1)
- **AC-2** — For each state an order can be in, its next act is `approve` exactly when an artifact awaits approval. (FR-2)
- **AC-3** — Running an order from queue to ship leaves a history in which every event names a worker, and its checks, files, worktree setup, rebase and landing appear only as evidence. The operator's last act in it is approving the Review artifact, or a retried ship. (FR-3, FR-4)
- **AC-4** — A `fix` order's plan, build and review briefs each state the line, and each station skill directs a `fix` order through its `dim-fix` part. (FR-5, FR-6)
- **AC-5** — A session hook whose `dim` command fails or is missing still exits 0. (NF-1)
- **AC-6** — A git hook in a repo whose owner, config or check it cannot read exits 0; one that refuses a subject, check or push exits non-zero and says why. (NF-2)
- **AC-7** — A write issued through a reader's connection fails and leaves the database unchanged. (NF-3)
- **AC-8** — Each station's brief for a given order and turn is exactly its header and its data sections, with no sentence of procedure. (FR-7)
- **AC-9** — A command whose environment names the operator, under no registered ancestor, is refused; a process reusing a registered pid with another start time is refused; a process under a running station command, before its worker registers, is refused. (FR-8, FR-9)
- **AC-10** — A query, `dim sql`, `dim stats`, `dim trace` and the wall, given a record stamped with an older or newer schema version, each refuse it with the error the writer raises, and leave it unchanged. (NF-3, NF-4)
- **AC-11** — Under an owner environment holding API keys, a forge token and an agent socket, neither a worker nor the check sees any of them, and only a Claude worker sees the subscription token. (FR-10)

## 6. Open decisions

- How the next act is derived from the record, within FR-2.
- Where evidence is stored and how it is shown beside the history, within FR-4.
- How a kept worktree or branch is reported, within FR-1.

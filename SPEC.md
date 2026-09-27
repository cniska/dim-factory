# dim-factory Specification

> A local record of every coding-agent session on this machine, and a factory that runs orders through plan, build and review stations under that record.

This document states what must hold, not how. [`docs/`](docs/) explains how each part works and why; where a doc touches one of these rules it links here rather than restating it.

## 1. Orders

- **FR-1** — An order whose commits landed on the local default branch is recorded as shipped, whether or not its worktree and branch could be removed.
- **FR-2** — An order is held only while one of its artifacts awaits approval. In every other state its next act is one the operator can run.
- **FR-3** — An order's history holds only the acts its workers took, each naming its worker. A station that fails before its worker exists is the one act that names none.
- **FR-4** — What the factory itself records about an order — its checks, its changed files, its worktree's setup — is evidence beside the history, never an act in it.

## 2. Stations

- **FR-5** — Every station brief names the order's line, save a build turn that resolves a rebase conflict.
- **FR-6** — A station skill routes on the line it is briefed with: a `fix` order's station runs `dim-fix`'s part for that station, and a `feat` order's never does.

## 3. Hooks and reads

- **NF-1** — A hook a coding-agent session runs exits 0 whatever happens.
- **NF-2** — A git hook `dim` installs exits non-zero only to refuse a commit or push it has read and understood; anything it cannot read lets the commit or push through.
- **NF-3** — A reader cannot change the record it reads: a query, `dim sql` and the wall fail on any write rather than make it.

## 4. Acceptance criteria

- **AC-1** — Shipping an order whose worktree cannot be removed lands its commits, records it shipped, and names the kept worktree and branch with their reasons. (FR-1)
- **AC-2** — For each state an order can be in, its next act is `approve` exactly when an artifact awaits approval. (FR-2)
- **AC-3** — Running an order from queue to ship leaves a history in which every event names a worker, and its checks, files and worktree setup appear only as evidence. (FR-3, FR-4)
- **AC-4** — A `fix` order's plan, build and review briefs each state the line, and each station skill directs a `fix` order through its `dim-fix` part. (FR-5, FR-6)
- **AC-5** — A session hook whose `dim` command fails or is missing still exits 0. (NF-1)
- **AC-6** — A git hook in a repo whose owner, config or check it cannot read exits 0; one that refuses a subject, check or push exits non-zero and says why. (NF-2)
- **AC-7** — A write issued through a reader's connection fails and leaves the database unchanged. (NF-3)

## 5. Open decisions

- How the next act is derived from the record, within FR-2.
- Where evidence is stored and how it is shown beside the history, within FR-4.
- How a kept worktree or branch is reported, within FR-1.

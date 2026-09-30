---
name: dim-git
description: Apply the factory's Git policy — who owns a workspace, how a slice is committed and handed to the gates, how a ship's conflict is resolved, and what never happens to history. Use whenever Git work touches an order's workspace or a shared branch.
argument-hint: "<git operation or factory context>"
---

# Git

The shared Git boundary for the factory. Use this skill whenever Git work affects ownership, evidence, or a shared branch.

## Establish ownership

- Read the current status, branch and recent commits before changing anything.
- In a factory order, work in the order's workspace: its own repository, on the branch `dim/<order>`. Outside an order, follow the repository's checkout rules before editing.
- One order owns one item end to end. Do not touch another order's workspace or combine unrelated changes into its commits.
- Outside an order, preserve uncommitted changes you did not create: stage by naming paths, never `git add -A`, `git add .` or `git add --all`, and stop when the target or ownership is unclear. An order's workspace holds only the order's work, so there a commit stages every change.

## Commit a slice

A commit is evidence that one slice passed `dim-build`'s slice loop, not a save point for unfinished work.

In a factory order, commit the slice with `git add -A && git commit -m "<subject>"` and hand it in with `dim slice submit`. The gates keep it only when it is one new commit on the order's recorded head, it leaves the check's declaration as it was, the workspace is clean, and the repository's declared check passes on it without changing a file. A refused commit is taken back off the branch and its changes stay in the workspace: answer the reason, commit again and submit again. Do not `--amend`, `reset` or `rebase` a submitted commit; the factory puts the branch back at the recorded head and the rewrite is lost.

Take the subject's form from the repository's `git log`. The repository's hooks do not run in a workspace; the gates judge the commit.

An unwanted commit is dropped, never reverted: reset or rebase it out while it is still local and unsubmitted. Once it is on a shared branch, dropping it rewrites that branch, which is the owner's call — stop and ask. A revert leaves both commits in the history and the message git writes for it answers to no one.

Outside a factory order, record the commit SHA, changed files, check command and result, reviewer findings and resolutions, and documentation updated. In an order, the factory records the commit and the check's output. A hold or infrastructure failure is part of the report; it is not green evidence.

## Resolve a ship's conflict

Shipping rebases an order onto the moved default branch. When a commit conflicts, the order comes back to build with the brief's `conflict` naming the paths, and the workspace holds the merge with its conflict markers. Resolve only those paths, so each carries both the order's change and the default branch's with no marker left, change nothing else, then commit the resolution as an ordinary commit and `dim slice submit` it. Nothing after it is replayed; the resolution is the order's new head.

## Land work

Workers never land. Approving the Review artifact ships the order: the factory rebases it, checks it and moves the default branch.

Do not force-push, rewrite a shared branch, or push outside the explicit owner authorization. A push is an outward-facing hold even when the local checks are green.

## Report the boundary

Report the change or order, its workspace and branch, the commit or commits, check and review evidence, documentation status, and final outcome. For a factory order, include its id and any hold or blocker.

## Red flags

- touching the project's checkout, or another order's workspace, from a worker
- outside an order, staging a whole tree rather than the paths the change touched
- committing before the repository check and review are complete
- amending, resetting or rebasing a commit already submitted
- treating a reviewer finding as optional because tests pass
- pushing or rewriting history without the owner's authorization
- reverting a commit instead of dropping it

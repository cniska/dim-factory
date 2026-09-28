---
name: dim-git
description: Apply the factory's Git policy across lines and stations, from isolated worktrees through verified commits and serialized integration.
argument-hint: "<git operation or factory context>"
---

# Git

The shared Git boundary for the factory. Use this skill whenever Git work affects ownership, evidence, or the factory's serialized line.

## Establish ownership

- Read the current status, worktree, branch and recent commits before changing anything.
- Work in the worktree assigned to a factory order. Outside an order, follow the repository's checkout rules before editing.
- One order owns one item end to end. Do not edit another order's worktree or combine unrelated changes into its commit.
- Preserve uncommitted changes you did not create. Stage by naming paths, never `git add -A`, `git add .` or `git add --all`. Stop when the target or ownership is unclear.

## Commit a slice

A commit is evidence that one slice passed `dim-build`'s slice loop, not a save point for unfinished work. Outside an order, commit a passing slice yourself.

In a factory order, leave the slice uncommitted on the order's branch and return its subject. The runner runs the declared check in its sandbox, commits with the repository's own identity and signing, and records the evidence; it fails a turn that moved the branch or nested a repository.

Take the subject's form from the commit subjects the brief says the record has seen, or from the repository's `git log` where the record holds too few to read one. The repository's hooks decide what git accepts, and the runner refuses a new code comment where the repository bans them. A refused commit comes back in the same turn with its reason and the changes still uncommitted: answer it, and return the whole result again.

An unwanted commit is dropped, never reverted: reset or rebase it out while it is still local. Once it is pushed, dropping it rewrites the shared branch, which is the owner's call — stop and ask. A revert leaves both commits in the history and the message git writes for it answers to no one.

Outside a factory order, record the commit SHA, changed files, check command and result, reviewer findings and resolutions, and documentation updated. The factory runner records the order's commit and check evidence. A hold or infrastructure failure is part of the report; it is not green evidence.

## Resolve a rebase conflict

Shipping rebases an order onto the moved default branch, and a conflict comes back to the builder with the worktree mid-rebase. Resolve only the listed files, so each carries both the order's change and the trunk's with no conflict markers, and change nothing else. Leave the resolution unstaged and run no git command that stages, continues, aborts or commits; the runner continues the rebase, re-checks it and sends the order back to review. A later commit that conflicts comes back in the same turn. The turn's subject is not used, since the rebase keeps each commit's own message.

## Land work

Integration is serialized. Before integrating a completed item, verify its report, commit ancestry, repository check, documentation status and hold. Integrate only the commits that belong to the item, then verify the resulting target branch.

Do not force-push, rewrite a shared branch, or push outside the explicit owner authorization. A push is an outward-facing hold even when the local checks are green.

## Report the boundary

Report the change or order, its worktree and branch, the commit or commits, check and review evidence, documentation status, and final outcome. For a factory order, include its id and any hold or blocker.

## Red flags

- editing the parent worktree from a worker
- staging a whole tree rather than the paths the slice changed
- committing before the repository check and review are complete
- treating a reviewer finding as optional because tests pass
- integrating two items together when their claims were separate
- pushing or rewriting history without the owner's authorization
- reverting a commit instead of dropping it

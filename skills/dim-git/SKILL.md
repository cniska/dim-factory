---
name: dim-git
description: The git rules factory workers follow — the workspace, how a slice is committed and handed to the gates, how a ship's conflict is resolved, and what is never done to history. Use whenever git work touches an order's workspace.
---

# Git

## The workspace

An order is built in its workspace: a linked git worktree of the project's checkout on the branch `dim/<order>`, outside the project. It holds only the order's work, so a commit stages every change with `git add -A`. The project's own hooks run on the commit as in any worktree of the project; a hook that refuses the commit is the project's rule, so answer it and commit again.

## A commit

One slice is one commit, handed in with `dim slice submit`. The subject takes its form from the project's `git log`.

The record holds the branch's head, and the factory moves the branch back to it whenever they disagree. A submitted commit that is amended, reset or rebased is refused as `head_moved`: the branch goes back to the recorded head and the changes stay in the workspace. An unwanted commit that is not yet submitted is reset out, never reverted.

## A ship's conflict

Shipping rebases the order onto the default branch as it stands. When the rebase conflicts, the order comes back to build with the brief's `conflict` naming the commit to rebase onto and the paths, and the workspace at the order's recorded head. Run `git rebase --reapply-cherry-picks --empty=keep <onto>`; in each conflicted path keep both the order's change and the default branch's with no marker left, change nothing else, `git add` it and `git rebase --continue`. With the rebase finished, `dim slice submit` hands in the branch, which the gates keep when it holds every commit they kept for the order, on `<onto>`, with the check passing.

## Landing

Workers never push. Approving the Review artifact ships the order: the factory rebases it, checks it and moves the default branch.

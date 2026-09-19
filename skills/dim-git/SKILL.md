---
name: dim-git
description: Apply the factory's Git policy across lines and stations, from isolated worktrees through verified commits and serialized integration.
argument-hint: "<git operation or factory context>"
---

# Git

The shared Git boundary for the factory. Use this skill whenever Git work affects ownership, evidence, or the factory's serialized line.

## Establish ownership

- Read the current status, worktree, branch and recent commits before changing anything.
- Work in the isolated worktree assigned to the item. The parent worktree is not a worker workspace.
- One order owns one item end to end. Do not edit another order's worktree or combine unrelated changes into its commit.
- Preserve uncommitted changes you did not create. Stop when the target or ownership is unclear.

## Commit a slice

A commit is evidence that one slice passed its boundary, not a save point for unfinished work.

Before committing:

1. Run the repository's declared check and format the files the repository says to format.
2. Read the diff and simplify it without changing the intended behavior.
3. Have a checking agent inspect the diff read-only and answer every finding.
4. Update the long-lived documentation that describes the changed behavior.
5. Use the repository's commit convention and let its commit gate enforce the subject.

Record the commit SHA, changed files, check command and result, checker findings and resolutions, and documentation updated. A hold or infrastructure failure is part of the report; it is not green evidence.

## Review work

Review reads a diff, history and evidence without changing the worktree. It does not repair a finding in place or create a commit for someone else's item. The owner answers findings in the item's worktree, then reruns the relevant check and review.

## Land work

Integration is serialized. Before integrating a completed item, verify its report, commit ancestry, repository check, documentation status and hold. Integrate only the commits that belong to the item, then verify the resulting target branch.

Do not force-push, rewrite a shared branch, or push outside the explicit owner authorization. A push is an outward-facing hold even when the local checks are green.

## Report the boundary

Every stopped or completed operation says:

- the item, worktree and branch
- the commit or commits involved
- the check and review evidence
- the documentation status
- the hold, blocker or final outcome

## Red flags

- editing the parent worktree from a worker
- committing before the repository check and review are complete
- treating a checker finding as optional because tests pass
- integrating two items together when their claims were separate
- pushing or rewriting history without the owner's authorization

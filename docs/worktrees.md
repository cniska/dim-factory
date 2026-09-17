# Worktrees, and undoing what an agent wrote

Two pieces of tooling neither coding agent does well, and one of them already exists and has no home.

## Adopting `wt`

Task worktrees live at `<repo>/.claude/worktrees/<branch>`. That convention is load-bearing here: a query folds a worktree onto the checkout it copies, `prior-art` and `exemplars` would otherwise let a file compete with itself, and a session row names the worktree it ran in. [`worktree.ts`](../src/worktree.ts) is the one definition all of that reads.

The tool establishing the convention is `wt` — a bash wrapper over `git worktree` that creates or reuses a checkout, runs the repo's `scripts/worktree-setup.sh` on creation, and its `scripts/worktree-teardown.sh` before removal, keeping the branch so the work can still be merged. It has a behavioral test suite that passes, and it is published as a gist. What it does not have is a repository: nothing runs its tests, nothing verifies it, and the copy on PATH and the copy in the gist stay level by hand.

That is the case for adopting it here rather than tidiness. This is the one repo that already depends on its convention, already shells git for everything it does, and already installs machine-level things through a plan that is printed before `--write` applies it. Bringing `wt` in gives it CI and puts the convention and the tool that creates it in the same place.

Acolyte's own workspaces feature took the same shape — a five-phase program whose middle two phases are bootstrap on create and teardown on removal, deliberately mirroring `wt` so the two interoperate. It is parked on an unmerged branch, which is why the bash script is what actually runs.

## Undoing what an agent wrote

The recovery problem is separate and unsolved across both tools: a model makes a bad edit mid-task, and what exists is per-tool, proprietary and unqueryable.

Acolyte settled the constraint that governs any answer here: an agent must never change the user's repository as a side effect of running. No refs, no index, no worktrees, no hooks in the user's `.git`, because even an invisible mechanism mutates it and breaks expectations. Its checkpoints are therefore content snapshots under a directory it owns.

The same issue names the alternative it did not build: a git repository the agent owns, holding the touched files after each write, for cheap diffs and history. That is available here without violating the constraint, because the repository is this tool's own — a shadow git directory under this tool's data directory, with the checkout as its work tree, writing no ref and touching no index of the user's.

What makes it worth building here rather than anywhere else is the join. Every tool call is already indexed, so a snapshot carrying its tool call id makes recovery a query rather than a list: the tree as of the edit a later fix commit came back to, reachable from the session, the skill and the commit at once. A per-session snapshot directory has none of that.

Two things it must respect. A `PostToolUse` hook fires on every tool call, and a hook that can fail is a hook that can break every session — so the hook records that something changed and a later pass makes the commit, exactly as the session hooks spool rather than write. And a work tree honors the checkout's `.gitignore`, so what git ignores is not recoverable; the alternative is snapshotting files nobody asked to track.

## Not built

Neither. `wt` runs from PATH and is adopted here only as a decision.

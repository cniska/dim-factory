# Worktrees, and undoing what an agent wrote

Two pieces of tooling neither coding agent does well, and one of them already exists and has no home.

## Adopting `wt`

Task worktrees live at `<repo>/.claude/worktrees/<branch>`. That convention is load-bearing here: a query folds a worktree onto the checkout it copies, `prior-art` and `exemplars` would otherwise let a file compete with itself, and a session row names the worktree it ran in. [`worktree.ts`](../src/worktree.ts) is the one definition all of that reads.

The tool establishing the convention is `dim wt`: a wrapper over `git worktree` that creates or reuses a checkout, runs the repo's `scripts/worktree-setup.sh` on creation and its `scripts/worktree-teardown.sh` before removal, and keeps the branch so the work can still be merged. The case for it living here is that this is the one repo that already depends on its convention, already shells git for everything it does, and already installs machine-level things through a plan printed before `--write` applies it.

That is the case for adopting it here rather than tidiness. This is the one repo that already depends on its convention, already shells git for everything it does, and already installs machine-level things through a plan that is printed before `--write` applies it.

It ships as a subcommand ([`wt-command.ts`](../src/wt-command.ts)) rather than a file on PATH, so there is one installed thing and the tests cover it. Its suite is [`scripts/wt.test.sh`](../scripts/wt.test.sh), in bash, because the cases pin the messages and exit codes a caller reads; `bun run verify` points it at `dim wt`, so the command and the tests move together.

## Worker environments

A worktree may need more than tracked files before a worker can run. A repository-owned setup hook can install dependencies across workspace members, activate pinned tools, allocate isolated ports, create worker-specific service containers, materialize environment files and check health. Its teardown hook removes those resources before the worktree is removed. `workspaceContract` reports the checkout, worktree identity, declared tasks, package managers, Dart or Flutter bootstrap, members, capabilities, declared services, environment requirements and hook entry points; an absent declaration remains `null` or an empty collection. Declared services and environment requirements carry the file they were read from, and a repository with no such file is `null` there rather than an empty list.

`dim wt` owns the lifecycle around those hooks: it invokes setup after creation, invokes teardown before removal, prints a structured command/result/resource report, and keeps the worktree when teardown fails. It does not infer the repository's service topology or perform package installation on its own. The workspace profile supplies the package-manager and environment description that makes the hook's work visible; the hook remains the authority for side effects.

A teardown hook that is killed by a signal reports no exit code, and reading that as success would remove the worktree its resources are named by — so any status that is not a clean zero keeps the worktree, and `--force` is the only way past.

Acolyte's own workspaces feature took the same shape — a five-phase program whose middle two phases are bootstrap on create and teardown on removal, deliberately mirroring `wt` so the two interoperate. It is parked on an unmerged branch, which is why the bash script is what actually runs.

## Undoing what an agent wrote

The recovery problem is separate and unsolved across both tools: a model makes a bad edit mid-task, and what exists is per-tool, proprietary and unqueryable.

Acolyte settled the constraint that governs any answer here: an agent must never change the user's repository as a side effect of running. No refs, no index, no worktrees, no hooks in the user's `.git`, because even an invisible mechanism mutates it and breaks expectations. Its checkpoints are therefore content snapshots under a directory it owns.

The same issue names the alternative it did not build: a git repository the agent owns, holding the touched files after each write, for cheap diffs and history. That is available here without violating the constraint, because the repository is this tool's own — a shadow git directory under this tool's data directory, with the checkout as its work tree, writing no ref and touching no index of the user's.

What makes it worth building here rather than anywhere else is the join. Every tool call is already indexed, so a snapshot carrying its tool call id makes recovery a query rather than a list: the tree as of the edit a later fix commit came back to, reachable from the session, the skill and the commit at once. A per-session snapshot directory has none of that.

Two things it must respect. A `PostToolUse` hook fires on every tool call, and a hook that can fail is a hook that can break every session — so the hook records that something changed and a later pass makes the commit, exactly as the session hooks spool rather than write. And a work tree honors the checkout's `.gitignore`, so what git ignores is not recoverable; the alternative is snapshotting files nobody asked to track.

## Not built

Undoing an agent's writes.

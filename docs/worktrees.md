# Worktrees

## `dim wt`

- Task worktrees live at `<repo>/.claude/worktrees/<branch>`. Queries fold a worktree onto the checkout it copies, and a session row names the worktree it ran in; [`src/worktree.ts`](../src/worktree.ts) is the one definition.
- `dim wt` ([`src/wt-command.ts`](../src/wt-command.ts)) creates or reuses a worktree, runs the repo's `scripts/worktree-setup.sh` after creating it and `scripts/worktree-teardown.sh` before removing it, and keeps the branch.
- Its tests are [`scripts/wt.test.sh`](../scripts/wt.test.sh), in bash because they pin the messages and exit codes a caller reads; `bun run verify` runs them against `dim wt`.

## Worker environments

- The repository's setup hook owns the side effects: dependencies, pinned tools, ports, containers, environment files and health checks. Its teardown hook removes them.
- `dim wt` owns the lifecycle around the hooks and prints a report of each command, result and resource. It infers no service topology and installs nothing itself.
- Any teardown status other than a clean zero keeps the worktree, including a hook killed by a signal. `--force` is the only way past.
- [`factory.md`](factory.md#worker-environments) defines the workspace profile.

## Undoing an agent's writes

Not built (`undo-agent-writes` in [`build-order.md`](build-order.md)).

- **Constraint.** An agent never changes the user's repository as a side effect of running: no refs, no index, no hooks in the user's `.git`.
- **Shape.** A shadow git directory under `dim`'s data directory, with the checkout as its work tree, snapshotting touched files after each write. Each snapshot carries its tool call id, so recovery is a query: the tree as of the edit a later fix came back to.
- **The hook only records.** A `PostToolUse` hook notes that something changed and a later pass commits, as the session hooks spool rather than write.
- **Ignored files are not recoverable**, since the work tree honors the checkout's `.gitignore`.

# Worktrees

## `dim wt`

- Task worktrees live at `<repo>/.claude/worktrees/<branch>`. Queries fold a worktree onto the checkout it copies, and a session row names the worktree it ran in; [`src/worktree.ts`](../src/worktree.ts) is the one definition.
- [`src/worktree.ts`](../src/worktree.ts) creates or reuses a registered worktree for one branch segment, runs the repo's `scripts/worktree-setup.sh` after creating it and `scripts/worktree-teardown.sh` before removing it, and keeps the branch; `dim wt` ([`src/wt-command.ts`](../src/wt-command.ts)) and an order both use it. A failed setup removes the incomplete worktree. It removes a new branch if setup left its tip intact, and preserves a branch whose tip changed.
- Its tests are [`scripts/wt.test.sh`](../scripts/wt.test.sh), in bash because they pin the messages and exit codes a caller reads; `bun run verify` runs them against `dim wt`.

## Worker environments

- The repository's setup hook owns the side effects: dependencies, pinned tools, ports, containers, environment files and health checks. Its teardown hook removes them.
- The worktree module owns the lifecycle around the hooks and returns a report of each command, result and resource: `dim wt` prints it, and an order records it as evidence. It infers no service topology and installs nothing itself.
- Any teardown status other than a clean zero keeps the worktree, including a hook killed by a signal. `--force` is the only way past.
- [`factory.md`](factory.md#worker-environments) defines the workspace profile.

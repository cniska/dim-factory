const SHIP_METHODS = ["trunk", "pull-request"] as const;
export type ShipMethod = (typeof SHIP_METHODS)[number];

/**
 * How a repo says its work lands, read from `dim.ship` in its git config rather than
 * inferred: whether shipping means moving the trunk or opening a pull request is the
 * repo owner's decision, and a remote being present says nothing about which.
 *
 * `dir` is the primary checkout, and only its own config is read: a value one worktree
 * holds, or one set globally for every repo, is not that repo's declaration.
 * Every way the read comes back short carries a message written for the operator.
 */
export function shipMethod(dir: string): { method: ShipMethod } | { missing: string } | { invalid: string } {
  const run = Bun.spawnSync(["git", "-C", dir, "config", "--local", "--get", "dim.ship"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const fix = `declare it with \`git -C ${dir} config dim.ship trunk\``;
  // Exit 1 is git's own answer for a key that is not set; any other failure is a config it could not read.
  if (run.exitCode === 1) return { missing: `${dir} declares no ship method; ${fix}` };
  if (!run.success) {
    return { invalid: `${dir} has a git config that cannot be read: ${run.stderr.toString().trim()}` };
  }
  const value = run.stdout.toString().trim();
  const method = SHIP_METHODS.find((m) => m === value);
  if (!method) {
    return {
      invalid: `${dir} declares dim.ship = ${value}, which is not one of ${SHIP_METHODS.join(", ")}; ${fix}`,
    };
  }
  return { method };
}

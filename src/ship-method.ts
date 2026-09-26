const SHIP_METHODS = ["trunk", "pull-request"] as const;
export type ShipMethod = (typeof SHIP_METHODS)[number];

export function shipMethod(dir: string): { method: ShipMethod } | { missing: string } | { invalid: string } {
  const run = Bun.spawnSync(["git", "-C", dir, "config", "--local", "--get", "dim.ship"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const fix = `declare it with \`git -C ${dir} config dim.ship trunk\``;
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

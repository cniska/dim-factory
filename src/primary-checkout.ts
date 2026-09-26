import { dirname } from "node:path";

export function primaryCheckout(dir: string): string | null {
  const run = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return run.success ? dirname(run.stdout.toString().trim()) : null;
}

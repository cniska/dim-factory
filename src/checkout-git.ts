import { join } from "node:path";

export function checkoutGitPath(cwd: string): string | null {
  const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (top.exitCode !== 0) return null;
  const path = top.stdout.toString().trim();
  return path ? join(path, ".git") : null;
}

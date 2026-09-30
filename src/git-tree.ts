import type { Env } from "./paths";

export function git(worktree: string, args: string[], options: { env?: Env; stdin?: string } = {}) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], {
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

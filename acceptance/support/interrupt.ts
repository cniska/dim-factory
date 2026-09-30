import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "./machine";

export function killMatching(pattern: string): void {
  Bun.spawnSync(["pkill", "-9", "-f", pattern]);
}

export function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export function holdWhenMainMoves(machine: Machine, signal: string): void {
  const hooks = join(machine.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const signals = join(machine.state, "signals");
  const releases = join(machine.state, "releases");
  const hook = join(hooks, "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh
[ "$1" = committed ] || exit 0
grep -q " refs/heads/main$" || exit 0
mkdir -p "${signals}"
echo $PPID > "${signals}/${signal}"
while [ ! -e "${releases}/${signal}" ]; do sleep 0.05; done
`,
  );
  chmodSync(hook, 0o755);
}

const holdFile = (root: string) => join(root, "hold-check");

export const holdingCheck = (root: string): string =>
  `sh -c 'while [ -e "${holdFile(root)}" ]; do sleep 0.05; done' dim-held-check`;

export function holdCheck(machine: Machine): void {
  writeFileSync(holdFile(machine.root), "");
}

export function releaseCheck(machine: Machine): void {
  rmSync(holdFile(machine.root), { force: true });
}

export async function checkHeld(): Promise<void> {
  while (Bun.spawnSync(["pgrep", "-f", "dim-held-check"]).exitCode !== 0) await Bun.sleep(20);
}

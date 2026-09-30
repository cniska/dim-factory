import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Machine, MachinePaths } from "./machine";
import { releasePath, signalPath } from "./scripted-harness-state";

const HELD_CHECK = "check";

const armedPath = (root: string) => join(root, "hold-check");

const holdAndWait = (state: string, name: string, pid: string) =>
  `mkdir -p "${dirname(signalPath(state, name))}"; echo ${pid} > "${signalPath(state, name)}"; while [ ! -e "${releasePath(state, name)}" ]; do sleep 0.05; done`;

export const holdingCheck = ({ root, state }: MachinePaths): string =>
  `sh -c 'if [ -e "${armedPath(root)}" ]; then ${holdAndWait(state, HELD_CHECK, "$$")}; fi'`;

export function holdCheck(machine: Machine): void {
  writeFileSync(armedPath(machine.root), "");
}

export const checkHeld = (machine: Machine): Promise<number> => machine.reached(HELD_CHECK);

export function releaseCheck(machine: Machine): void {
  machine.release(HELD_CHECK);
}

export function holdWhenMainMoves(machine: Machine, signal: string): void {
  const hook = join(machine.repo, ".git", "hooks", "reference-transaction");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    `#!/bin/sh
[ "$1" = committed ] || exit 0
grep -q " refs/heads/main$" || exit 0
${holdAndWait(machine.state, signal, "$PPID")}
`,
  );
  chmodSync(hook, 0o755);
}

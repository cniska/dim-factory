import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Machine, MachinePaths } from "./machine";
import { commandOf, descendants } from "./processes";
import { releasePath, signalPath } from "./scripted-harness-state";
import { waitFor } from "./wait";

const HELD_CHECK = "check";

const armedPath = (root: string) => join(root, "hold-check");

const waitForRelease = (state: string, name: string) =>
  `while [ ! -e "${releasePath(state, name)}" ]; do sleep 0.05; done`;

export const holdingCheck = ({ root, state }: MachinePaths): string =>
  `sh -c 'if [ -e "${armedPath(root)}" ]; then ${waitForRelease(state, HELD_CHECK)}; fi'`;

export function holdCheck(machine: Machine): void {
  writeFileSync(armedPath(machine.root), "");
}

export async function checkHeld(machine: Machine): Promise<number> {
  const armed = armedPath(machine.root);
  const held = () => descendants(machine.operator.pid).filter((pid) => commandOf(pid).includes(armed));
  await waitFor("the check to be held", () => held().length > 0);
  const deepest = held().at(-1);
  if (deepest === undefined) throw new Error("the held check ended before it was found");
  return deepest;
}

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
mkdir -p "${dirname(signalPath(machine.state, signal))}"; echo $PPID > "${signalPath(machine.state, signal)}"
${waitForRelease(machine.state, signal)}
`,
  );
  chmodSync(hook, 0o755);
}

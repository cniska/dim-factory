import { commitMsgGate } from "./gate-commit-msg";
import { GATE_HOOKS, type Gate, type GateHook } from "./gate-contract";
import { preCommitGate } from "./gate-pre-commit";
import { prePushGate } from "./gate-push";

const GATES: Readonly<Record<GateHook, Gate>> = {
  "commit-msg": commitMsgGate,
  "pre-commit": preCommitGate,
  "pre-push": prePushGate,
};

export function gateFor(name: string): Gate | null {
  const hook = GATE_HOOKS.find((known) => known === name);
  return hook === undefined ? null : GATES[hook];
}

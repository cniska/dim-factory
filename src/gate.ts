import { basename } from "node:path";
import type { GateInput } from "./gate-contract";
import { hookOwners, ownersCover } from "./gate-hooks";
import { gateFor } from "./gate-registry";

export function judge(hookPath: string, input: GateInput): readonly string[] | null {
  const gate = gateFor(basename(hookPath));
  if (gate === null) return null;
  const owners = hookOwners(hookPath);
  if (owners === null || !ownersCover(owners, gate.owner(input))) return [];
  return gate.refusal(input);
}

import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { readGateChoice } from "./config";
import { installGates } from "./gates";
import { GATE_NAMES, type GateName, isGateName, refuseGates } from "./gates-contract";
import { pickGates } from "./gates-picker";
import { checkoutRoot } from "./git-checkout";

const USAGE = `usage: dim gates install [<gate>...], choosing from ${GATE_NAMES.join(", ")}`;

function named(positionals: readonly string[]): readonly GateName[] | null {
  if (positionals.length === 0) return null;
  const unknown = positionals.filter((name) => !isGateName(name));
  if (unknown.length > 0)
    throw new UsageError(`${unknown.join(", ")} is no gate; the gates are ${GATE_NAMES.join(", ")}`);
  if (new Set(positionals).size !== positionals.length) throw new UsageError("names each gate once");
  return positionals.filter(isGateName);
}

export const gatesCommand: Command = {
  name: "gates",
  usage: USAGE,
  summary:
    "install the gates this checkout chose, or choose them by name, moving a gate changed in place aside",
  async run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    const { positionals } = parseArgs(
      rest,
      { positionals: [0, GATE_NAMES.length], flags: [] },
      "dim gates install",
    );
    const cwd = process.cwd();
    const root = checkoutRoot(cwd);
    if (root === null) throw refuseGates("not_a_checkout", { cwd });
    const choice = named(positionals) ?? (readGateChoice(root) === null ? await pickGates() : null);
    return installGates(root, choice);
  },
};

import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { installGates } from "./gates";
import { refuseGates } from "./gates-contract";
import { checkoutRoot } from "./git-checkout";

const USAGE = "usage: dim gates install";

export const gatesCommand: Command = {
  name: "gates",
  usage: USAGE,
  summary: "install the canonical gates into this checkout, moving a gate changed in place aside",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "dim gates install");
    const cwd = process.cwd();
    const root = checkoutRoot(cwd);
    if (root === null) throw refuseGates("not_a_checkout", { cwd });
    return installGates(root);
  },
};

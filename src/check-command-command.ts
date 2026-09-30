import type { Command } from "./cli-contract";
import { checkTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";

export const checkCommandCommand: Command = {
  name: "check-command",
  usage: "usage: dim check-command",
  summary: "print the command line of the check task this repo declares, and nothing where it declares none",
  raw: () => true,
  run() {
    const root = checkoutRoot(process.cwd());
    const declared = root === null ? null : checkTask(root);
    if (declared) console.log(declared.commandLine);
  },
};

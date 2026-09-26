import { checkoutRoot } from "./checkout";
import type { Command } from "./command";
import { checkCommand } from "./workspace-commands";

export const checkCommandCommand: Command = {
  name: "check-command",
  usage: "usage: dim check-command",
  summary:
    "print the check command this repo declares, and nothing where it declares none, for the pre-commit hook",
  raw: () => true,
  run() {
    const root = checkoutRoot(process.cwd());
    const declared = root === null ? null : checkCommand(root);
    if (declared) console.log(declared.command);
  },
};

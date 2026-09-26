import { checkoutRoot } from "./checkout";
import type { Command } from "./command";
import { checkTask } from "./workspace-tasks";

export const checkCommandCommand: Command = {
  name: "check-command",
  usage: "usage: dim check-command",
  summary:
    "print the command line of the check task this repo declares, and nothing where it declares none, for the pre-commit hook",
  raw: () => true,
  run() {
    const root = checkoutRoot(process.cwd());
    const declared = root === null ? null : checkTask(root);
    if (declared) console.log(declared.commandLine);
  },
};

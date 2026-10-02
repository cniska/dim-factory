import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { installSkill } from "./skill";

const USAGE = "usage: dim skills install";

export const skillsCommand: Command = {
  name: "skills",
  usage: USAGE,
  summary: "link this repo's skills where each installed harness reads them, moving an occupied link aside",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "dim skills install");
    const changed = installSkill().filter((plan) => plan.state !== "linked");
    return {
      linked: changed.map((plan) => plan.link),
      backups: changed.flatMap((plan) => (plan.state === "occupied" ? [plan.backup] : [])),
    };
  },
};

import { type Command, UsageError } from "./cli-contract";
import { installSkill } from "./skill";

const USAGE = "usage: dim skills install";

export const skillsCommand: Command = {
  name: "skills",
  usage: USAGE,
  summary: "link this repo's skills where each installed harness reads them, moving an occupied link aside",
  run(args) {
    if (args[0] !== "install" || args.length > 1) throw new UsageError(USAGE);
    const changed = installSkill().filter((plan) => plan.state !== "linked");
    return {
      linked: changed.map((plan) => plan.link),
      backups: changed.flatMap((plan) => (plan.state === "occupied" ? [plan.backup] : [])),
    };
  },
};

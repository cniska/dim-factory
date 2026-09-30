import { type Command, UsageError } from "./cli-contract";
import { sendAct } from "./station-ops";

const USAGE = "usage: dim slice submit";

export const sliceCommand: Command = {
  name: "slice",
  usage: USAGE,
  summary: "hand in the slice just committed, from inside the builder's turn",
  run(args) {
    if (args[0] !== "submit" || args.length > 1) throw new UsageError(USAGE);
    return sendAct({ act: "slice_submit" });
  },
};

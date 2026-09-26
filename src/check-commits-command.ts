import { type Command, Ran, UsageError } from "./cli-contract";
import { checkRange } from "./gate-check-commits";

export const checkCommitsCommand: Command = {
  name: "check-commits",
  usage: "usage: dim check-commits <range>",
  summary:
    "judge every authored subject in a revision range by the rules the commit gate holds, naming each that breaks",
  run(args) {
    const [range] = args;
    if (!range) throw new UsageError("check-commits needs a revision range, e.g. main..HEAD");
    const offenses = checkRange(range);
    return new Ran({ range, offenses }, offenses.length === 0 ? 0 : 1);
  },
};

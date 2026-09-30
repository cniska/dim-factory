import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { Answer } from "./order-contract";
import { sendAct } from "./station-ops";

const USAGE = "usage: dim finding answer <finding> fixed|refused --reason <reason>";

export const findingCommand: Command = {
  name: "finding",
  usage: USAGE,
  summary: "answer a review finding once, from inside the builder's turn",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "answer") throw new UsageError(USAGE);
    const { positionals, flags } = parseArgs(
      rest,
      { positionals: [2, 2], flags: ["reason"] },
      (message) => new UsageError(`dim finding answer ${message}`),
    );
    const [finding, answer] = positionals;
    const parsed = Answer.safeParse(answer);
    if (finding === undefined || !parsed.success || flags.reason === undefined) throw new UsageError(USAGE);
    return sendAct(
      { act: "finding_answer", finding, answer: parsed.data, reason: flags.reason },
      process.env,
    );
  },
};

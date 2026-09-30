import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { sendAct } from "./station-ops";

const USAGE = "usage: dim review return --findings <file> | --artifact <file>";

export const reviewCommand: Command = {
  name: "review",
  usage: USAGE,
  summary: "return review findings or the Review artifact, from inside the reviewer's turn",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "return") throw new UsageError(USAGE);
    const { flags } = parseArgs(
      rest,
      { positionals: [0, 0], flags: ["findings", "artifact"] },
      () => new UsageError(USAGE),
    );
    const { findings, artifact } = flags;
    if (findings !== undefined && artifact === undefined) {
      return sendAct(
        { act: "review_return", returned: { kind: "findings", text: readFileSync(findings, "utf8") } },
        process.env,
      );
    }
    if (artifact !== undefined && findings === undefined) {
      return sendAct(
        { act: "review_return", returned: { kind: "artifact", text: readFileSync(artifact, "utf8") } },
        process.env,
      );
    }
    throw new UsageError(USAGE);
  },
};

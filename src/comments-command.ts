import { type Command, Ran, UsageError } from "./cli-contract";
import { purgeComments } from "./comments-ops";

const USAGE = "usage: dim comments purge [--write] [<path>...]";

function purge(args: string[]): unknown {
  const purged = purgeComments(process.cwd(), {
    write: args.includes("--write"),
    paths: args.filter((arg) => arg !== "--write"),
  });
  return purged.written && purged.failed ? new Ran(purged.report, 1) : purged.report;
}

export const commentsCommand: Command = {
  name: "comments",
  usage: USAGE,
  summary: "purge the comments a repo holds",
  run(args) {
    const [verb, ...rest] = args;
    if (verb === "purge") return purge(rest);
    throw new UsageError(verb === undefined ? "comments takes purge" : `${verb} is not a comments verb`);
  },
};

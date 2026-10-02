import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { dbPath } from "./paths";
import { showSession } from "./worker-ops";

const USAGE = "usage: dim session show <session>";

export const sessionCommand: Command = {
  name: "session",
  usage: USAGE,
  summary: "print the factory's copy of a station worker's session transcript",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "show") throw new UsageError(USAGE);
    const [session] = parseArgs(rest, { positionals: [1, 1], flags: [] }, "dim session show").positionals;
    if (session === undefined) throw new UsageError(USAGE);
    const db = openReadOnly(dbPath());
    try {
      return showSession(db, session);
    } finally {
      db.close();
    }
  },
};

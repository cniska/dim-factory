import { type Command, UsageError } from "./cli-contract";
import { closeDb } from "./db";
import { openFactory } from "./factory-db";
import { showSession } from "./worker-ops";

const USAGE = "usage: dim session show <session>";

export const sessionCommand: Command = {
  name: "session",
  usage: USAGE,
  summary: "print the factory's copy of a station worker's session transcript",
  run(args) {
    const [verb, session, ...rest] = args;
    if (verb !== "show" || session === undefined || rest.length > 0) throw new UsageError(USAGE);
    const db = openFactory();
    try {
      return showSession(db, session);
    } finally {
      closeDb(db);
    }
  },
};

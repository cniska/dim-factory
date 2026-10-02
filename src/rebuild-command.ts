import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";

const usage = (message: string) => new UsageError(`dim rebuild ${message}`);

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "usage: dim rebuild",
  summary: "forget every cursor and read all files from the start",
  run(args) {
    parseArgs(args, { positionals: [0, 0], flags: [] }, usage);
    return withLock(() => withDb(dbPath(), rebuild, { forRebuild: true }));
  },
};

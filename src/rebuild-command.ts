import { type Command, UsageError } from "./cli-contract";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";

const USAGE = "usage: dim rebuild";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: USAGE,
  summary: "forget every cursor and read all files from the start",
  run(args) {
    if (args.length > 0) throw new UsageError(USAGE);
    return withLock(() => withDb(dbPath(), rebuild, { forRebuild: true }));
  },
};

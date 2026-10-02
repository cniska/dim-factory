import { type Command, UsageError } from "./cli-contract";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { sync } from "./ingest-sync";
import { dbPath } from "./paths";

const USAGE = "usage: dim sync";

export const syncCommand: Command = {
  name: "sync",
  usage: USAGE,
  summary: "read every new byte of every tool's session files",
  run(args) {
    if (args.length > 0) throw new UsageError(USAGE);
    return withLock(() => withDb(dbPath(), sync));
  },
};

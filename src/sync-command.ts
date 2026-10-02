import type { Command } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { sync } from "./ingest-sync";
import { dbPath } from "./paths";

export const syncCommand: Command = {
  name: "sync",
  usage: "usage: dim sync",
  summary: "read every new byte of every tool's session files",
  run(args) {
    parseArgs(args, { positionals: [0, 0], flags: [] }, "dim sync");
    return withLock(() => withDb(dbPath(), sync));
  },
};

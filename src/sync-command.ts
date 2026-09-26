import type { Command } from "./cli-contract";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { sync } from "./ingest-sync";
import { dbPath } from "./paths";

export const syncCommand: Command = {
  name: "sync",
  usage: "usage: dim sync",
  summary: "read every new byte of both tools' session files",
  run: () => withLock(() => withDb(dbPath(), sync)),
};

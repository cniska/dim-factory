import type { Command } from "./command";
import { withDb } from "./db";
import { withLock } from "./lock";
import { dbPath } from "./paths";
import { sync } from "./sync";

export const syncCommand: Command = {
  name: "sync",
  usage: "usage: dim sync",
  summary: "read every new byte of both tools' session files",
  run: () => withLock(() => withDb(dbPath(), sync)),
};

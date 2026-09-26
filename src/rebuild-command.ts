import type { Command } from "./command";
import { withDb } from "./db";
import { withLock } from "./lock";
import { dbPath } from "./paths";
import { rebuild } from "./sync";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "usage: dim rebuild",
  summary: "forget every cursor and read all files from the start",
  run: () => withLock(() => withDb(dbPath(), rebuild, { forRebuild: true })),
};

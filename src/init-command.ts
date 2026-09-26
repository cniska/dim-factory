import type { Command } from "./cli-contract";
import { closeDb, openDb } from "./db";
import { dbPath } from "./paths";

export const initCommand: Command = {
  name: "init",
  usage: "usage: dim init",
  summary: "create the database and its schema",
  run() {
    closeDb(openDb(dbPath()));
    return { database: dbPath() };
  },
};

import type { Command } from "./cli-contract";
import { withDb } from "./db";
import { findingFrom, recordFinding } from "./finding";
import { dbPath } from "./paths";

export const findingCommand: Command = {
  name: "finding",
  usage:
    'usage: dim finding --slice <name> --dimension <name> --answer <fixed|refused> --summary "..." [--file <path>] [--why "..."]',
  summary: "record what a checking agent raised on a slice and how it was answered; a refusal states why",
  run(args) {
    const finding = findingFrom(args, process.cwd());
    withDb(dbPath(), (db) => recordFinding(db, finding));
    return finding;
  },
};

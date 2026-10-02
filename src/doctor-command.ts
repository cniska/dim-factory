import { type Command, Ran, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { diagnose } from "./doctor";
import { dbPath } from "./paths";

const usage = (message: string) => new UsageError(`dim doctor ${message}`);

export const doctorCommand: Command = {
  name: "doctor",
  usage: "usage: dim doctor",
  summary: "check that collection is actually working, and say what to fix",
  run(args) {
    parseArgs(args, { positionals: [0, 0], flags: [] }, usage);
    const db = openReadOnly(dbPath(), { forDiagnosis: true });
    try {
      const checks = diagnose(db, process.env);
      const failing = checks.filter((check) => check.state === "fail").length;
      return new Ran({ checks, failing }, failing === 0 ? 0 : 1);
    } finally {
      db.close();
    }
  },
};

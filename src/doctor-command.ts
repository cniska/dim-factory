import { type Command, Ran, UsageError } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { diagnose } from "./doctor";
import { dbPath } from "./paths";

const USAGE = "usage: dim doctor";

export const doctorCommand: Command = {
  name: "doctor",
  usage: USAGE,
  summary: "check that collection is actually working, and say what to fix",
  run(args) {
    if (args.length > 0) throw new UsageError(USAGE);
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

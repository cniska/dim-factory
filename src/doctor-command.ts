import { type Command, Ran } from "./command";
import { diagnose } from "./doctor";
import { dbPath } from "./paths";
import { openReadOnly } from "./read-db";

export const doctorCommand: Command = {
  name: "doctor",
  usage: "usage: dim doctor",
  summary: "check that collection and the gates are actually working, and say what to fix",
  run() {
    const db = openReadOnly(dbPath());
    try {
      const checks = diagnose(db);
      const failing = checks.filter((check) => check.state === "fail").length;
      return new Ran({ checks, failing }, failing === 0 ? 0 : 1);
    } finally {
      db.close();
    }
  },
};

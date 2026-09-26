import { type Command, UsageError } from "./cli-contract";
import { withDb } from "./db";
import { createSchedule, setSchedulePaused } from "./factory-schedule";
import { dbPath } from "./paths";

export const scheduleCommand: Command = {
  name: "schedule",
  usage:
    "usage: dim schedule define <id> <queue> --every <seconds> [--paused]\n       dim schedule pause|resume <id>",
  summary: "persist a harness-neutral recurring schedule, or pause and resume one",
  run(args) {
    const [action, id, queue] = args;
    if (action === "define") {
      const everyAt = args.indexOf("--every");
      const intervalSeconds = everyAt === -1 ? Number.NaN : Number(args[everyAt + 1]);
      if (!id || !queue || !Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
        throw new UsageError("define takes an id, a queue and --every <positive-seconds>");
      }
      return withDb(dbPath(), (db) => {
        createSchedule(db, { id, queueId: queue, intervalSeconds, paused: args.includes("--paused") });
        return { action: "defined", schedule_id: id, queue_id: queue };
      });
    }
    if ((action === "pause" || action === "resume") && id) {
      return withDb(dbPath(), (db) => {
        setSchedulePaused(db, id, action === "pause");
        return { action, schedule_id: id };
      });
    }
    throw new UsageError(`${action ?? "schedule"} is not a schedule subcommand`);
  },
};

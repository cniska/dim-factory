import { type Command, UsageError } from "./cli-contract";
import { withDb } from "./db";
import { dbPath } from "./paths";

const LABELS = ["correction", "clarification", "not_correction"];

export const labelCommand: Command = {
  name: "label",
  usage: 'usage: dim label <message-id> <correction|clarification|not_correction> [--rule "..."]',
  summary: "record your judgement on one candidate correction",
  run(args) {
    const [messageId, label] = args;
    const ruleAt = args.indexOf("--rule");
    const rule = ruleAt === -1 ? null : (args[ruleAt + 1] ?? null);
    if (!messageId || !label) throw new UsageError("label takes a message id and a label");
    if (!LABELS.includes(label)) throw new UsageError(`${label} is not one of ${LABELS.join(", ")}`);
    return withDb(dbPath(), (db) => {
      if (!db.prepare("SELECT id FROM message WHERE id = ?").get(messageId)) {
        throw new UsageError(`no message ${messageId}`);
      }
      db.run(
        `INSERT INTO correction_label (message_id, label, rule, labeled_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(message_id) DO UPDATE SET label = excluded.label, rule = excluded.rule,
           labeled_at = excluded.labeled_at`,
        [messageId, label, rule],
      );
      return { message: messageId, label, rule };
    });
  },
};

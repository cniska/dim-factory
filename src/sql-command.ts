import { type Command, UsageError } from "./cli-contract";
import { positionalArg } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { dbPath } from "./paths";
import { capRows, rowsFromArgs } from "./query-row-cap";

export const sqlCommand: Command = {
  name: "sql",
  usage: 'usage: dim sql "<select>" [--rows <n>]',
  summary: "run one read-only statement against the database",
  run(args) {
    const statement = positionalArg(args, ["--rows"], (message) => new UsageError(`sql ${message}`));
    if (!statement)
      throw new UsageError('sql needs one statement, as in: dim sql "SELECT count(*) FROM session"');
    const maxRows = rowsFromArgs(args);
    const db = openReadOnly(dbPath());
    try {
      const rows = db.prepare(statement).all() as Record<string, unknown>[];
      return {
        denominator: `${rows.length} rows`,
        ...capRows(rows, maxRows),
        note: rows.length === 0 ? "the statement ran and matched nothing" : null,
      };
    } finally {
      db.close();
    }
  },
};

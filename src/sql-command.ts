import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { dbPath } from "./paths";
import { capRows, rowsOf } from "./query-row-cap";

export const sqlCommand: Command = {
  name: "sql",
  usage: 'usage: dim sql "<select>" [--rows <n>]',
  summary: "run one read-only statement against the database",
  run(args) {
    const { positionals, flags } = parseArgs(
      args,
      { positionals: [0, 1], flags: ["rows"] },
      (message) => new UsageError(`sql ${message}`),
    );
    const [statement] = positionals;
    if (!statement)
      throw new UsageError('sql needs one statement, as in: dim sql "SELECT count(*) FROM session"');
    const maxRows = rowsOf(flags.rows);
    const db = openReadOnly(dbPath());
    try {
      const rows = db.query<Record<string, unknown>, []>(statement).all();
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

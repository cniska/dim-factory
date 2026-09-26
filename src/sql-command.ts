import { type Command, UsageError } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { dbPath } from "./paths";
import { capRows, rowsFromArgs } from "./query-row-cap";

function statementIn(args: string[]): string | undefined {
  const rows = args.indexOf("--rows");
  const value = rows === -1 ? -1 : rows + 1;
  return args.find((a, i) => !a.startsWith("--") && i !== value);
}

export const sqlCommand: Command = {
  name: "sql",
  usage: 'usage: dim sql "<select>" [--rows <n>]',
  summary: "run one read-only statement against the database",
  run(args) {
    const statement = statementIn(args);
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

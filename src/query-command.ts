import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { QueryResult } from "./query";
import { findQuery, QUERIES } from "./query-registry";
import { capRows, DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";
import { trace } from "./trace";

export const queryCommand: Command = {
  name: "query",
  usage: "usage: dim query <name> [arg] [--rows <n>] | dim query list",
  summary: `ask the database a named question; ${DEFAULT_MAX_ROWS} rows print unless --rows widens them`,
  async run(args) {
    const name = args[0];
    if (!name || name === "list") {
      return {
        queries: QUERIES.map((q) => ({
          name: q.name,
          usage: q.usage,
          summary: q.summary,
        })),
      };
    }
    const query = findQuery(name);
    if (!query) throw new UsageError(`no query named ${name}; dim query list names them`);
    const { positionals, flags } = parseArgs(
      args.slice(1),
      { positionals: [0, 1], flags: ["rows"] },
      (message) => new UsageError(`dim query ${name} ${message}`),
    );
    const [arg] = positionals;
    const maxRows = rowsOf(flags.rows);
    const db = openReadOnly(dbPath());
    const started = Date.now();
    let result: QueryResult | undefined;
    try {
      result = query.run(db, { arg, home: resolveHomeDir(), maxRows });
      return { ...result, ...capRows(result.rows, maxRows) };
    } finally {
      trace({
        event: "query.completed",
        command: "query",
        name: query.name,
        rowCount: result?.rows.length,
        durationMs: Date.now() - started,
      });
      db.close();
    }
  },
};

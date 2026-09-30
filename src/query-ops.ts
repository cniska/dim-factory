import { openReadOnly } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { Query, QueryResult } from "./query";
import { QUERIES } from "./query-registry";
import { capRows } from "./query-row-cap";
import { trace } from "./trace";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(query: Query, arg: string | undefined, maxRows: number) {
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
}

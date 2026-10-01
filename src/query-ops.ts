import { openReadOnly } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { Query } from "./query";
import { QUERIES } from "./query-registry";
import { capRows } from "./query-row-cap";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(query: Query, arg: string | undefined, maxRows: number) {
  const db = openReadOnly(dbPath());
  try {
    const result = query.run(db, { arg, home: resolveHomeDir(), maxRows });
    return { ...result, ...capRows(result.rows, maxRows) };
  } finally {
    db.close();
  }
}

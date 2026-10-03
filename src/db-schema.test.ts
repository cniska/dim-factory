import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";

type KeyColumn = {
  readonly table: string;
  readonly key: string;
  readonly seq: number;
  readonly column: string;
};

function columnsByKey(rows: readonly KeyColumn[]): ReadonlyMap<string, readonly string[]> {
  const keys = new Map<string, string[]>();
  for (const { table, key, column } of [...rows].sort((a, b) => a.seq - b.seq)) {
    const id = `${table}:${key}`;
    keys.set(id, [...(keys.get(id) ?? []), column]);
  }
  return keys;
}

test("every foreign key leads an index, so a delete of the rows it references does not scan its table", () => {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const foreignKeys = columnsByKey(
    db
      .query<KeyColumn, []>(
        `SELECT m.name AS "table", f.id AS "key", f.seq AS seq, f."from" AS "column"
         FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table'`,
      )
      .all(),
  );
  const indexes = columnsByKey(
    db
      .query<KeyColumn, []>(
        `SELECT m.name AS "table", l.name AS "key", i.seqno AS seq, i.name AS "column"
         FROM sqlite_master m JOIN pragma_index_list(m.name) l JOIN pragma_index_info(l.name) i
         WHERE m.type = 'table'`,
      )
      .all(),
  );
  const tableOf = (id: string) => id.slice(0, id.indexOf(":"));
  const led = (id: string, columns: readonly string[]) =>
    [...indexes].some(
      ([index, indexed]) =>
        tableOf(index) === tableOf(id) && columns.every((column, position) => indexed[position] === column),
    );
  expect(foreignKeys.size).toBeGreaterThan(0);
  expect(
    [...foreignKeys]
      .filter(([id, columns]) => !led(id, columns))
      .map(([id, columns]) => `${tableOf(id)}(${columns})`),
  ).toEqual([]);
});

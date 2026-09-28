#!/usr/bin/env bun
import { closeDb, openDb, writeTransaction } from "../src/db";
import { FACTORY_ORDER_TABLES } from "../src/ingest-sync";
import { dbPath } from "../src/paths";

const required = "--confirm-factory-reset";

if (!process.argv.includes(required)) {
  throw new Error(`refusing to reset factory state; pass ${required}`);
}

if (!process.env.DIM_HOME) {
  throw new Error("refusing to reset the default data directory; set DIM_HOME explicitly");
}

const db = openDb(dbPath());
try {
  const childrenFirst = [...FACTORY_ORDER_TABLES].reverse();
  const counts = childrenFirst.map((table) => ({
    table,
    rows: db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
  }));
  writeTransaction(db, () => {
    for (const table of childrenFirst) db.run(`DELETE FROM ${table}`);
  });
  for (const count of counts) console.log(`${count.table}\t${count.rows}`);
} finally {
  closeDb(db);
}

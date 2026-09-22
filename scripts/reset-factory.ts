#!/usr/bin/env bun
import { closeDb, openDb } from "../src/db";
import { dataDir, dbPath } from "../src/paths";
import { rmSync } from "node:fs";
import { join } from "node:path";

const required = "--confirm-factory-reset";
const carried = new Set(["factory_handoff"]);
const tables = [
  "factory_order_environment",
  "factory_order_document",
  "factory_order_finding",
  "factory_order_review",
  "factory_order_plan",
  "factory_order_check",
  "factory_order_file",
  "factory_order_commit",
  "factory_order_attempt",
  "factory_order_event",
  "factory_order_worker",
  "factory_order",
  "factory_stop",
  "factory_schedule",
  "factory_worker_assignment",
  "factory_worker_session",
  "factory_worker",
];

if (!process.argv.includes(required)) {
  throw new Error(`refusing to reset factory state; pass ${required}`);
}

if (!process.env.DIM_HOME) {
  throw new Error("refusing to reset the default data directory; set DIM_HOME explicitly");
}

const db = openDb(dbPath());
try {
  const factoryTables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_%'")
    .all()
    .map((row) => row.name);
  const unknown = factoryTables.filter((table) => !tables.includes(table) && !carried.has(table));
  if (unknown.length > 0) throw new Error(`refusing to reset unknown factory tables: ${unknown.join(", ")}`);

  const counts = tables.map((table) => ({
    table,
    rows: db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0,
  }));
  db.transaction(() => {
    for (const table of tables) db.run(`DELETE FROM ${table}`);
  })();
  rmSync(join(dataDir(), "worker-credentials"), { recursive: true, force: true });

  for (const count of counts) console.log(`${count.table}\t${count.rows}`);
  console.log(`preserved\t${[...carried].join(", ")}`);
  console.log("removed\tworker-credentials");
} finally {
  closeDb(db);
}

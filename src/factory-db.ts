import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import { ORDER_SQL } from "./order-store";
import { dbPath } from "./paths";
import { WORKER_SQL } from "./worker-store";

export const FACTORY_SQL = [WORKER_SQL, ORDER_SQL].join("");

export function openFactory(path: string = dbPath()): Database {
  const db = openDb(path);
  try {
    db.run(FACTORY_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

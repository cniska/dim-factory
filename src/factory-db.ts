import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import { ORDER_SQL } from "./order-store";
import { dbPath } from "./paths";

export const FACTORY_SQL = ORDER_SQL;

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

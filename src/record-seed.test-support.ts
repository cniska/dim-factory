import type { Database } from "bun:sqlite";
import type { LogEntry } from "./order-contract";
import { appendEntry } from "./order-store";
import { insertWorker } from "./worker-store";

export function seedOperator(db: Database, name: string, project: string): void {
  insertWorker(db, { role: "operator", name, project });
}

export function seedEntry(db: Database, order: string, entry: LogEntry): void {
  appendEntry(db, order, entry);
}

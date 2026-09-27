import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export class NoDatabaseError extends Error {
  readonly code = "NO_DATABASE";
  constructor(path: string) {
    super(`no database at ${path}; run \`dim sync\` first`);
  }
}

export function openReadOnly(path: string): Database {
  if (!existsSync(path)) throw new NoDatabaseError(path);
  const db = new Database(path, { readwrite: true, create: false });
  db.run("PRAGMA query_only = ON");
  return db;
}

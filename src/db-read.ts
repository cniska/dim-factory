import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { refuseOtherSchema, storedSchemaVersion } from "./db";

export class NoDatabaseError extends Error {
  readonly code = "NO_DATABASE";
  constructor(path: string) {
    super(`no database at ${path}; run \`dim sync\` first`);
  }
}

export function openReadOnly(path: string): Database {
  if (!existsSync(path)) throw new NoDatabaseError(path);
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.run("PRAGMA query_only = ON");
    refuseOtherSchema(storedSchemaVersion(db));
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

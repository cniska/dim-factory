import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { CodedError } from "./coded-error";
import { refuseOtherVersion } from "./db";

export class NoDatabaseError extends CodedError<"no_database", { readonly path: string }> {
  constructor(path: string) {
    super("no_database", `no database at ${path}; run \`dim sync\` first`, { path }, "dim sync");
  }
}

export function openReadOnly(path: string, options: { forDiagnosis?: boolean } = {}): Database {
  if (!existsSync(path)) throw new NoDatabaseError(path);
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.run("PRAGMA query_only = ON");
    if (!options.forDiagnosis) refuseOtherVersion(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

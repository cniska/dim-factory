import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export class NoDatabaseError extends Error {
  readonly code = "NO_DATABASE";
  constructor(path: string) {
    super(`no database at ${path}; run \`dim sync\` first`);
  }
}

/**
 * Every reader opens with SQLite's read-only flag. `hook_event` is the one table
 * with no source to re-read from, so a wrong query from a person or an agent
 * driving this must not be able to reach it with a write.
 */
export function openReadOnly(path: string): Database {
  if (!existsSync(path)) throw new NoDatabaseError(path);
  return new Database(path, { readonly: true });
}

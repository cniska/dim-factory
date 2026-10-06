import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { invariant } from "../assert";

export const RECORD_CHANGE_CHECK_MS = 100;

type Watching = { readonly db: Database; readonly inode: number; version: number };

export function recordChanges(
  path: string,
  changed: () => void,
  everyMs = RECORD_CHANGE_CHECK_MS,
): () => void {
  let watching: Watching | null = null;
  const forget = () => {
    watching?.db.close();
    watching = null;
  };
  const check = () => {
    const file = statSync(path, { throwIfNoEntry: false });
    if (file === undefined) {
      if (watching !== null) changed();
      forget();
      return;
    }
    if (watching === null || watching.inode !== file.ino) {
      forget();
      const db = new Database(path, { readwrite: true, create: false });
      watching = { db, inode: file.ino, version: versionOf(db) };
      changed();
      return;
    }
    const version = versionOf(watching.db);
    if (version === watching.version) return;
    watching.version = version;
    changed();
  };
  const timer = setInterval(check, everyMs);
  check();
  return () => {
    clearInterval(timer);
    forget();
  };
}

function versionOf(db: Database): number {
  const row = db.query<{ data_version: number }, []>("PRAGMA data_version").get();
  invariant(row !== null, "PRAGMA data_version returns one row");
  return row.data_version;
}

import { Database } from "bun:sqlite";
import { closeDb, openDb } from "./db";

/**
 * A second process against one database file, because a busy wait blocks the thread it runs on:
 * a lock held on the same thread could never be released while the other connection waits.
 * Each step prints a line and waits for one on stdin, so the test orders the two writers
 * explicitly rather than by process start-up time.
 *
 *   hold <path> <who>   takes the write lock with a bare connection and commits on the next line
 *   write <path> <who>  opens through `openDb`, waits for a line, then commits one row
 *   open <path> <who>   commits one row straight after opening through `openDb`
 */
const [mode, path, who] = process.argv.slice(2) as [string, string, string];
function nextLine(): Promise<void> {
  return new Promise((resolve) =>
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    }),
  );
}

if (mode === "hold") {
  const db = new Database(path);
  db.run("BEGIN IMMEDIATE");
  db.run("INSERT INTO probe (who) VALUES (?)", [who]);
  console.log("held");
  await nextLine();
  db.run("COMMIT");
  db.close();
} else if (mode === "write") {
  const db = openDb(path);
  console.log("opened");
  await nextLine();
  console.log("writing");
  db.run("INSERT INTO probe (who) VALUES (?)", [who]);
  closeDb(db);
} else if (mode === "open") {
  console.log("opening");
  const db = openDb(path);
  db.run("INSERT INTO probe (who) VALUES (?)", [who]);
  closeDb(db);
} else {
  throw new Error(`unknown mode ${mode}`);
}

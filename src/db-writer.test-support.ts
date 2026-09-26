import { Database } from "bun:sqlite";
import { closeDb, openDb } from "./db";

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

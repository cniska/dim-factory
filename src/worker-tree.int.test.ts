import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { WORKER_NAME_VAR } from "./factory-worker";
import { SCHEMA_SQL } from "./schema";
import { runWorkerCommand } from "./worker-command";

describe("worker tree integration", () => {
  test("records the current worker as the real child process parent", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const parentSession = "operator-session";
    const printed = runWorkerCommand(db, ["register", "--role", "operator"], {
      DIM_SESSION_ID: parentSession,
    });
    const parentEnv: Record<string, string> = { DIM_SESSION_ID: parentSession };
    for (const line of printed.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      parentEnv[name as string] = value as string;
    }

    runWorkerCommand(db, ["run", "--role", "builder", "--", "sh", "-c", "true"], parentEnv);

    expect(db.query("SELECT role, parent_worker FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      role: "builder",
      parent_worker: parentEnv[WORKER_NAME_VAR],
    });
    db.close();
  });
});

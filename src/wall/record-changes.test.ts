import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../db";
import { recordChanges } from "./record-changes";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
}

test("hears another connection's write within a check, and is quiet while nothing is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "dim-record-changes-"));
  roots.push(root);
  const path = join(root, "record.db");
  const writer = openDb(path);
  let heard = 0;
  const stop = recordChanges(
    path,
    () => {
      heard += 1;
    },
    20,
  );
  try {
    expect(heard).toBe(1);
    await Bun.sleep(100);
    expect(heard).toBe(1);
    writer.run(
      "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('x', 'claude', 'transcript', 's')",
    );
    await until(() => heard > 1);
    expect(heard).toBe(2);
  } finally {
    stop();
    closeDb(writer);
  }
});

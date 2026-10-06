import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, writeTransaction } from "../db";
import { hearRecordWrites } from "./record-notices";

const roots: string[] = [];
const PORT_ENV = "DIM_WALL_PORT";
const portBefore = process.env[PORT_ENV];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (portBefore === undefined) delete process.env[PORT_ENV];
  else process.env[PORT_ENV] = portBefore;
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
}

function recordIn(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `dim-${name}-`));
  roots.push(root);
  return join(root, "record.db");
}

const INSERT =
  "INSERT INTO source_file (path, tool, kind, session_id) VALUES (?, 'claude', 'transcript', 's')";

test("hears each committed write to its own record once, and nothing written to another record", async () => {
  const path = recordIn("heard");
  const other = recordIn("other");
  const writer = openDb(path);
  const elsewhere = openDb(other);
  let heard = 0;
  const { port, stop } = await hearRecordWrites(path, 0, () => {
    heard += 1;
  });
  process.env[PORT_ENV] = String(port);
  try {
    writeTransaction(elsewhere, () => elsewhere.run(INSERT, ["elsewhere"]));
    await Bun.sleep(50);
    expect(heard).toBe(0);

    writeTransaction(writer, () => writer.run(INSERT, ["one"]));
    await until(() => heard > 0);
    expect(heard).toBe(1);
  } finally {
    stop();
    writer.close();
    elsewhere.close();
  }
});

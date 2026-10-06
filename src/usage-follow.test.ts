import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "./db";
import { claudeTranscriptLines } from "./fixtures.test-support";
import { followUsage } from "./usage-follow";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";

test("records a running worker's token usage as its transcript grows, before the turn ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "dim-usage-follow-"));
  roots.push(root);
  const db = openDb(join(root, "record.db"));
  const transcript = join(root, "home", ".claude", "projects", "-w", `${SESSION}.jsonl`);
  const usage = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage").get()?.n;
  const stop = followUsage(db, transcript);
  try {
    expect(usage()).toBe(0);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      `${claudeTranscriptLines(SESSION)
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const until = Date.now() + 2000;
    while (usage() === 0 && Date.now() < until) await Bun.sleep(20);
    expect(usage()).toBeGreaterThan(0);
  } finally {
    stop();
    closeDb(db);
  }
});

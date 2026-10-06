import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db";
import { claudeTranscriptLines } from "./fixtures.test-support";
import { followUsage } from "./usage-follow";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";

const transcriptText = (rename: string) =>
  `${claudeTranscriptLines(SESSION)
    .map((line) => JSON.stringify(line).replaceAll("msg-1", rename).replaceAll('"u-1"', `"u-${rename}"`))
    .join("\n")}\n`;

test("records a running worker's token usage each time the worker speaks, before the turn ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "dim-usage-follow-"));
  roots.push(root);
  const db = openDb(join(root, "record.db"));
  const transcript = join(root, "home", ".claude", "projects", "-w", `${SESSION}.jsonl`);
  const usage = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage").get()?.n ?? 0;
  const follow = followUsage(db, transcript);
  try {
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, transcriptText("msg-first"));
    follow.heard();
    await Bun.sleep(0);
    const first = usage();
    expect(first).toBeGreaterThan(0);

    appendFileSync(transcript, transcriptText("msg-second"));
    follow.heard();
    await Bun.sleep(0);
    expect(usage()).toBeGreaterThan(first);
  } finally {
    follow.stop();
    db.close();
  }
});

test("reads what the worker wrote last when the turn ends, though nothing was heard", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-usage-follow-"));
  roots.push(root);
  const db = openDb(join(root, "record.db"));
  const transcript = join(root, "home", ".claude", "projects", "-w", `${SESSION}.jsonl`);
  const follow = followUsage(db, transcript);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, transcriptText("msg-only"));
  follow.stop();
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage").get()?.n).toBeGreaterThan(0);
  db.close();
});

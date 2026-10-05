import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySession } from "./station-effects";
import type { Trace } from "./trace-contract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const trace: Trace = {
  step: (_name, _start, perform, ..._result) => perform(),
  stepAsync: (_name, _start, perform, ..._result) => perform(),
};

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "dim-effects-"));
  roots.push(root);
  const transcript = join(root, "home", "s1.jsonl");
  const subagents = join(root, "home", "s1", "subagents");
  const copies = join(root, "workers", "w", "sessions");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(transcript, "main\n");
  return { transcript, subagents, copies };
}

describe("copying a session", () => {
  test("copies the transcript and every subagent transcript and meta beside it", () => {
    const { transcript, subagents, copies } = scratch();
    writeFileSync(join(subagents, "agent-a1.jsonl"), "one\n");
    writeFileSync(join(subagents, "agent-a1.meta.json"), '{"agentType":"Explore"}');
    writeFileSync(join(subagents, "agent-b2.jsonl"), "two\n");
    writeFileSync(join(subagents, "notes.txt"), "not a transcript");

    copySession(trace, transcript, subagents, copies, "s1");

    expect(readFileSync(join(copies, "s1.jsonl"), "utf8")).toBe("main\n");
    const copied = join(copies, "s1", "subagents");
    expect(readFileSync(join(copied, "agent-a1.jsonl"), "utf8")).toBe("one\n");
    expect(readFileSync(join(copied, "agent-a1.meta.json"), "utf8")).toBe('{"agentType":"Explore"}');
    expect(readFileSync(join(copied, "agent-b2.jsonl"), "utf8")).toBe("two\n");
    expect(existsSync(join(copied, "notes.txt"))).toBe(false);
  });

  test("copies only the transcript when the session ran no subagent", () => {
    const { transcript, subagents, copies } = scratch();
    rmSync(subagents, { recursive: true });

    copySession(trace, transcript, subagents, copies, "s1");

    expect(readFileSync(join(copies, "s1.jsonl"), "utf8")).toBe("main\n");
    expect(existsSync(join(copies, "s1"))).toBe(false);
  });
});

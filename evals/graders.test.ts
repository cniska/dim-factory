import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "./grader-contract";
import { GRADERS } from "./graders";
import { toolCallsOf } from "./transcript";

const FIXTURES = join(import.meta.dir, "graders", "fixtures");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-evals-"));
  roots.push(root);
  return root;
}

function runOf(fixture: string, tmp = scratch()): Run {
  const lines = readFileSync(join(FIXTURES, fixture), "utf8").split("\n");
  return { toolCalls: toolCallsOf(lines), workspace: scratch(), tmp };
}

describe("no-refused-shell", () => {
  test("fails a run where the harness refused a shell call", () => {
    expect(GRADERS["no-refused-shell"].grade(runOf("no-refused-shell/fail.jsonl")).pass).toBe(false);
  });

  test("passes a run whose failed shell call ran, ignoring what the agent wrote in prose", () => {
    expect(GRADERS["no-refused-shell"].grade(runOf("no-refused-shell/pass.jsonl")).pass).toBe(true);
  });
});

describe("plan-file-written", () => {
  const grade = (contents: string | null) => {
    const tmp = scratch();
    if (contents !== null) writeFileSync(join(tmp, "plan.json"), contents);
    return GRADERS["plan-file-written"].grade({ toolCalls: [], workspace: scratch(), tmp }).pass;
  };

  test("passes a plan file holding a body and at least one slice", () => {
    expect(grade('{"body": "## Outcome", "slices": [{"title": "One", "outcome": "Done."}]}')).toBe(true);
  });

  test("fails a missing plan file, one that does not parse, and one without slices", () => {
    expect(grade(null)).toBe(false);
    expect(grade("{not json")).toBe(false);
    expect(grade('{"body": "## Outcome", "slices": []}')).toBe(false);
  });
});

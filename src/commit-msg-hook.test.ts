import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(import.meta.dir, "..", "gates", "commit-msg");
const repo = mkdtempSync(join(tmpdir(), "dim-commit-msg-"));
Bun.spawnSync(["git", "init", "-q", repo]);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function judged(message: string) {
  const file = join(repo, "MESSAGE");
  writeFileSync(file, message);
  const ran = Bun.spawnSync(["sh", HOOK, file], { cwd: repo, stderr: "pipe" });
  return { exitCode: ran.exitCode, stderr: ran.stderr.toString() };
}

describe("the commit-msg hook", () => {
  test("lets a short Conventional Commit subject through, and a fixup of one", () => {
    expect(judged("feat: add a thing\n").exitCode).toBe(0);
    expect(judged("fix(order): keep the head\n# a git comment line\n").exitCode).toBe(0);
    expect(judged("fixup! fixup! docs: say what holds\n").exitCode).toBe(0);
  });

  test("refuses a subject that is not a Conventional Commit", () => {
    expect(judged("Add a thing\n")).toEqual({
      exitCode: 1,
      stderr:
        "commit-msg: subject is not a Conventional Commit (type(scope): what changed).\n  got: Add a thing\n",
    });
  });

  test("refuses a body, a subject over 50 characters, a non-ASCII subject and an empty one", () => {
    expect(judged("feat: x\n\nbecause\n").stderr).toContain("commit has a body");
    expect(judged(`feat: ${"x".repeat(45)}\n`).stderr).toContain(
      "subject is 51 characters, over the 50 allowed.",
    );
    expect(judged(`feat: ${"x".repeat(44)}\n`).exitCode).toBe(0);
    expect(judged("feat: café\n").stderr).toContain("subject is not ASCII.");
    expect(judged("\n").stderr).toContain("subject is empty.");
  });
});

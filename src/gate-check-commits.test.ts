import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRange } from "./gate-check-commits";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-range-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

function commit(dir: string, message: string): void {
  writeFileSync(join(dir, `f${Math.random()}`), "x");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "--no-verify", "-m", message]);
}

describe("checking a pushed range", () => {
  test("names every commit that broke a rule, and the rule it broke", () => {
    const dir = repo();
    try {
      commit(dir, "feat: the first commit");
      const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      commit(dir, "feat: a conforming subject");
      commit(dir, "made some changes");
      commit(dir, `feat: ${"a".repeat(60)}`);
      commit(dir, "feat: a subject\n\nand a body explaining it");

      const offenses = checkRange(`${base}..HEAD`, dir);
      expect(offenses.map((o) => o.violation)).toEqual(["body", "too-long", "not-conventional"]);
      expect(offenses.map((o) => o.subject)).toContain("made some changes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes a range where every subject conforms", () => {
    const dir = repo();
    try {
      commit(dir, "feat: the first commit");
      const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      commit(dir, "fix(gate): hold the limit at fifty");
      expect(checkRange(`${base}..HEAD`, dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a range it cannot enumerate", () => {
    const dir = repo();
    try {
      commit(dir, "feat: the first commit");
      expect(() => checkRange("0000000..HEAD", dir)).toThrow("cannot enumerate commits");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scratchEnv } from "./fixtures.test-support";
import { SKILL_NAMES } from "./skill";

function installSkills(root: string) {
  const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "skills", "install"], {
    env: { ...process.env, ...scratchEnv(root), HOME: root },
  });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()).result;
}

test("skills install reports the links it made, and none on a second run", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-skill-write-"));
  try {
    const written = installSkills(root);
    expect(written.linked).toContain(join(root, ".claude", "skills", SKILL_NAMES[0]));
    expect(written.linked).toHaveLength(SKILL_NAMES.length);
    expect(written.backups).toEqual([]);
    expect(installSkills(root)).toEqual({ linked: [], backups: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills install reports where it moved an occupied link", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-skill-occupied-"));
  try {
    const occupied = join(root, ".claude", "skills", SKILL_NAMES[0]);
    mkdirSync(occupied, { recursive: true });
    const written = installSkills(root);
    expect(written.backups).toEqual([`${occupied}.dim-backup`]);
    expect(existsSync(`${occupied}.dim-backup`)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

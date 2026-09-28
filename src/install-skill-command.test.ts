import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scratchEnv } from "./fixtures.test-support";
import { SKILL_NAMES } from "./skill";

function installSkill(root: string, ...args: string[]) {
  const run = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "cli.ts"), "install-skill", ...args],
    {
      env: { ...process.env, ...scratchEnv(root), HOME: root },
    },
  );
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()).result;
}

test("install-skill --write reports the skills it linked as linked", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-skill-write-"));
  try {
    const written = installSkill(root, "--write");
    const after = installSkill(root);
    expect({ linked: written.linked, links: written.links }).toEqual(after);
    expect(written.backups).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-skill --write reports where it moved an occupied link", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-skill-occupied-"));
  try {
    const occupied = join(root, ".agents", "skills", SKILL_NAMES[0]);
    mkdirSync(occupied, { recursive: true });
    const written = installSkill(root, "--write");
    expect(written.backups).toEqual([`${occupied}.dim-backup`]);
    expect(existsSync(`${occupied}.dim-backup`)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

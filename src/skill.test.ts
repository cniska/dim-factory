import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, planSkill, SKILL_NAME, skillSourceDir } from "./skill";

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dim-skill-"));
  return home;
}

describe("skill install", () => {
  test("the skill it installs is the one in this repo", () => {
    expect(existsSync(join(skillSourceDir(), "SKILL.md"))).toBe(true);
  });

  test("links the skill where agents look for it", () => {
    const home = newHome();
    try {
      expect(planSkill({ HOME: home }).state).toBe("missing");
      installSkill({ HOME: home });
      const link = join(home, ".agents", "skills", SKILL_NAME);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(skillSourceDir());
      expect(planSkill({ HOME: home }).state).toBe("linked");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("moves aside a skill already at that name rather than removing it", () => {
    const home = newHome();
    const link = join(home, ".agents", "skills", SKILL_NAME);
    try {
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, "SKILL.md"), "the owner's own skill");
      expect(planSkill({ HOME: home }).state).toBe("occupied");

      installSkill({ HOME: home });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // The displaced skill may exist nowhere else, so it is kept, not deleted.
      expect(Bun.file(`${link}.dim-backup/SKILL.md`).size).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

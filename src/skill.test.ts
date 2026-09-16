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

  test("links the skill where every tool looks for it", () => {
    const home = newHome();
    try {
      expect(planSkill({ HOME: home }).map((p) => p.state)).toEqual(["missing", "missing"]);
      installSkill({ HOME: home });
      // Claude and Acolyte share `.agents/skills`; Codex reads its own directory,
      // and a link in only one of them leaves the other tool unable to ask.
      for (const dir of [join(home, ".agents", "skills"), join(home, ".codex", "skills")]) {
        const link = join(dir, SKILL_NAME);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(skillSourceDir());
      }
      expect(planSkill({ HOME: home }).every((p) => p.state === "linked")).toBe(true);
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
      expect(planSkill({ HOME: home })[0]?.state).toBe("occupied");

      installSkill({ HOME: home });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // The displaced skill may exist nowhere else, so it is kept, not deleted.
      expect(Bun.file(`${link}.dim-backup/SKILL.md`).size).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

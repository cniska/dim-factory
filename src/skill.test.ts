import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSkill, planSkill, SKILL_NAMES, skillLinkDirs, skillSourceDir } from "./skill";

function shipped(): string[] {
  return [...SKILL_NAMES].sort();
}

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "dim-skill-"));
}

describe("skill install", () => {
  // Literals, not the constant: importing SKILL_NAMES would let a dropped skill
  // ratify its own removal.
  test("ships the skills that need dim on PATH", () => {
    expect(shipped()).toEqual(["df-delegate", "df-sessions"]);
  });

  test("installs every skill directory in the repo, so a new one is not left behind", () => {
    const dirs = readdirSync(resolve(import.meta.dir, "..", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(shipped()).toEqual(dirs);
  });

  test("every skill it installs is one in this repo", () => {
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(skillSourceDir(name), "SKILL.md"))).toBe(true);
    }
  });

  test("links every skill where every tool looks for it", () => {
    const home = newHome();
    try {
      expect(planSkill({ HOME: home }).every((p) => p.state === "missing")).toBe(true);
      installSkill({ HOME: home });
      // Claude and Acolyte share `.agents/skills`; Codex reads its own directory,
      // and a link in only one of them leaves the other tool unable to ask.
      for (const dir of skillLinkDirs({ HOME: home })) {
        for (const name of SKILL_NAMES) {
          const link = join(dir, name);
          expect(lstatSync(link).isSymbolicLink()).toBe(true);
          expect(readlinkSync(link)).toBe(skillSourceDir(name));
        }
      }
      expect(planSkill({ HOME: home }).every((p) => p.state === "linked")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a skill linked for one tool still leaves the other pending", () => {
    const home = newHome();
    const [first] = skillLinkDirs({ HOME: home });
    try {
      mkdirSync(first as string, { recursive: true });
      const name = SKILL_NAMES[0];
      symlinkSync(skillSourceDir(name), join(first as string, name));
      const pending = planSkill({ HOME: home }).filter((p) => p.state !== "linked");
      expect(pending).not.toHaveLength(0);
      expect(pending.some((p) => p.name === name)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("moves aside a skill already at that name rather than removing it", () => {
    const home = newHome();
    const name = SKILL_NAMES[0];
    const link = join(home, ".agents", "skills", name);
    try {
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, "SKILL.md"), "the owner's own skill");
      expect(planSkill({ HOME: home }).find((p) => p.link === link)?.state).toBe("occupied");

      installSkill({ HOME: home });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // The displaced skill may exist nowhere else, so it is kept, not deleted.
      expect(Bun.file(`${link}.dim-backup/SKILL.md`).size).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

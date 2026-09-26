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
import { installSkill, planSkill, retiredLinks, SKILL_NAMES, skillLinkDirs, skillSourceDir } from "./skill";

function shipped(): string[] {
  return [...SKILL_NAMES].sort();
}

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "dim-skill-"));
}

describe("skill install", () => {
  test("ships the skills that need dim on PATH", () => {
    expect(shipped()).toEqual([
      "dim-add",
      "dim-artifact",
      "dim-design",
      "dim-factory",
      "dim-git",
      "dim-line-feat",
      "dim-line-fix",
      "dim-rules",
      "dim-simplify",
      "dim-station-build",
      "dim-station-plan",
      "dim-station-review",
      "dim-tdd",
    ]);
  });

  test("installs every skill directory in the repo, so a new one is not left behind", () => {
    const dirs = readdirSync(resolve(import.meta.dir, "..", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(shipped()).toEqual(dirs);
  });

  test("unlinks a station that no longer ships, and leaves the owner's own alone", () => {
    const home = newHome();
    const env = { HOME: home };
    const dir = join(home, ".agents", "skills");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(resolve(import.meta.dir, "..", "skills"), "dim-retired"), join(dir, "dim-retired"));
    symlinkSync(join(home, "elsewhere"), join(dir, "theirs"));

    installSkill(env);
    expect(retiredLinks(env)).toEqual([]);
    expect(lstatSync(join(dir, "theirs")).isSymbolicLink()).toBe(true);
  });

  test("install-skill --write retires a stale link when every current skill is already linked", () => {
    const home = newHome();
    try {
      installSkill({ HOME: home });
      const stale = join(home, ".codex", "skills", "dim-retired");
      symlinkSync(join(resolve(import.meta.dir, "..", "skills"), "dim-retired"), stale);

      const run = Bun.spawnSync(
        [process.execPath, resolve(import.meta.dir, "cli.ts"), "install-skill", "--write"],
        {
          env: { ...process.env, HOME: home },
        },
      );
      expect(run.exitCode).toBe(0);
      expect(lstatSync(stale, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      expect(Bun.file(`${link}.dim-backup/SKILL.md`).size).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

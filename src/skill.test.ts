import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";
import { LockHeldError, withPathLock } from "./db-lock";
import { harnessesOnPath } from "./fixtures.test-support";
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
      "dim-audit",
      "dim-build",
      "dim-factory",
      "dim-plan",
      "dim-review",
      "dim-rules",
    ]);
  });

  test("every skill a shipped skill names is shipped too", () => {
    const skills = resolve(import.meta.dir, "..", "skills");
    const named = [...new Glob("**/*.md").scanSync({ cwd: skills, followSymlinks: false })].flatMap((file) =>
      [...readFileSync(join(skills, file), "utf8").matchAll(/`(dim-[a-z]+)`/g)].map((match) => match[1]),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !shipped().includes(name as string))).toEqual([]);
  });

  test("installs every skill directory in the repo, so a new one is not left behind", () => {
    const dirs = readdirSync(resolve(import.meta.dir, "..", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(resolve(import.meta.dir, "..", "skills", e.name, "SKILL.md")))
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

  test("skills install retires a stale link when every current skill is already linked", () => {
    const home = newHome();
    try {
      const codex = harnessesOnPath(home, ["codex"]);
      installSkill({ HOME: home, PATH: codex });
      const stale = join(home, ".codex", "skills", "dim-retired");
      symlinkSync(join(resolve(import.meta.dir, "..", "skills"), "dim-retired"), stale);

      const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "skills", "install"], {
        env: { ...process.env, HOME: home, PATH: `${codex}:${process.env.PATH}` },
      });
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
    const env = { HOME: home, PATH: harnessesOnPath(home, ["codex"]) };
    try {
      expect(skillLinkDirs(env)).toEqual([join(home, ".agents", "skills"), join(home, ".codex", "skills")]);
      expect(planSkill(env).every((p) => p.state === "missing")).toBe(true);
      installSkill(env);
      for (const dir of skillLinkDirs(env)) {
        for (const name of SKILL_NAMES) {
          const link = join(dir, name);
          expect(lstatSync(link).isSymbolicLink()).toBe(true);
          expect(readlinkSync(link)).toBe(skillSourceDir(name));
        }
      }
      expect(planSkill(env).every((p) => p.state === "linked")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("every relative link in an installed skill resolves from where it is installed", () => {
    const home = newHome();
    const env = { HOME: home };
    try {
      installSkill(env);
      const [dir] = skillLinkDirs(env);
      const unresolved = SKILL_NAMES.flatMap((name) => {
        const skill = join(dir as string, name);
        return [...new Glob("**/*.md").scanSync({ cwd: skill, followSymlinks: true })].flatMap((file) => {
          const from = dirname(join(skill, file));
          return [...readFileSync(join(skill, file), "utf8").matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
            .map((match) => match[1] as string)
            .filter((target) => !/^[a-z]+:/.test(target))
            .filter((target) => !existsSync(join(from, target)))
            .map((target) => `${name}/${file} -> ${target}`);
        });
      });
      expect(unresolved).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("links the codex skills only where codex is installed", () => {
    const home = newHome();
    try {
      const env = { HOME: home, PATH: harnessesOnPath(home, ["claude"]) };
      expect(skillLinkDirs(env)).toEqual([join(home, ".agents", "skills")]);
      installSkill(env);
      expect(existsSync(join(home, ".codex", "skills"))).toBe(false);
      expect(planSkill(env).every((p) => p.state === "linked")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a skill linked for one tool still leaves the other pending", () => {
    const home = newHome();
    const env = { HOME: home, PATH: harnessesOnPath(home, ["codex"]) };
    const [first] = skillLinkDirs(env);
    try {
      mkdirSync(first as string, { recursive: true });
      const name = SKILL_NAMES[0];
      symlinkSync(skillSourceDir(name), join(first as string, name));
      const pending = planSkill(env).filter((p) => p.state !== "linked");
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

  test("preserves an earlier backup when replacing an occupied skill", async () => {
    const home = newHome();
    const name = SKILL_NAMES[0];
    const link = join(home, ".agents", "skills", name);
    try {
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, "SKILL.md"), "current skill");
      writeFileSync(`${link}.dim-backup`, "earlier backup");

      const plan = planSkill({ HOME: home }).find((p) => p.link === link);
      expect(plan).toMatchObject({ state: "occupied", backup: `${link}.dim-backup-2` });
      installSkill({ HOME: home });

      expect(await Bun.file(`${link}.dim-backup`).text()).toBe("earlier backup");
      expect(await Bun.file(`${link}.dim-backup-2/SKILL.md`).text()).toBe("current skill");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves an occupied skill untouched while another installer holds the lock", async () => {
    const home = newHome();
    const env = { HOME: home };
    const link = join(home, ".agents", "skills", SKILL_NAMES[0]);
    try {
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, "SKILL.md"), "owner skill");
      withPathLock(join(home, ".local", "state", "dim-factory", "locks", "skill-install"), () => {
        expect(() => installSkill(env)).toThrow(LockHeldError);
      });
      await expect(Bun.file(join(link, "SKILL.md")).text()).resolves.toBe("owner skill");
      expect(existsSync(`${link}.dim-backup`)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves a user's directory in the shared skills folder alone", async () => {
    const home = newHome();
    const occupied = join(home, ".agents", "skills", ".dim-install-lock");
    try {
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, "keep.txt"), "owner data");
      installSkill({ HOME: home });
      await expect(Bun.file(join(occupied, "keep.txt")).text()).resolves.toBe("owner data");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

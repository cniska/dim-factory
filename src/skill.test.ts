import { afterEach, describe, expect, test } from "bun:test";
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
import { invariant } from "./assert";
import { withPathLock } from "./db-lock";
import { harnessesOnPath } from "./fixtures.test-support";
import { installSkill, planSkill, SKILL_NAMES, skillLinkDirs, skillSourceDir } from "./skill";

const SKILLS = resolve(import.meta.dir, "..", "skills");
const homes: string[] = [];

function shipped(): string[] {
  return [...SKILL_NAMES].sort();
}

function machine(harnesses: readonly string[]): { HOME: string; PATH: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-skill-"));
  homes.push(home);
  return { HOME: home, PATH: harnessesOnPath(home, harnesses) };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("skill install", () => {
  test("ships one skill, the operator's", () => {
    expect(shipped()).toEqual(["dim-factory"]);
  });

  test("every file a shipped skill links is shipped too", () => {
    const links = [...new Glob("**/*.md").scanSync({ cwd: SKILLS })].flatMap((file) =>
      [...readFileSync(join(SKILLS, file), "utf8").matchAll(/\]\(([^)#]+\.md)\)/g)].flatMap((match) =>
        match[1] === undefined ? [] : [join(SKILLS, dirname(file), match[1])],
      ),
    );
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((link) => !existsSync(link))).toEqual([]);
  });

  test("installs every skill directory in the repo, so a new one is not left behind", () => {
    const dirs = readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(SKILLS, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
    expect(shipped()).toEqual(dirs);
  });

  test("links every skill into Claude Code's skill directory", () => {
    const env = machine(["claude"]);
    expect(skillLinkDirs(env)).toEqual([join(env.HOME, ".claude", "skills")]);
    expect(planSkill(env).every((p) => p.state === "missing")).toBe(true);
    installSkill(env);
    for (const dir of skillLinkDirs(env)) {
      for (const name of SKILL_NAMES) {
        expect(readlinkSync(join(dir, name))).toBe(skillSourceDir(name));
      }
    }
    expect(planSkill(env).every((p) => p.state === "linked")).toBe(true);
  });

  test("links nothing while Claude Code is not installed", () => {
    const env = machine([]);
    expect(skillLinkDirs(env)).toEqual([]);
    installSkill(env);
    expect(existsSync(join(env.HOME, ".claude", "skills"))).toBe(false);
  });

  test("links through a skill directory that is a link to one not made yet", () => {
    const env = machine(["claude"]);
    mkdirSync(join(env.HOME, ".claude"));
    symlinkSync("../.agents/skills", join(env.HOME, ".claude", "skills"));
    installSkill(env);
    expect(readlinkSync(join(env.HOME, ".agents", "skills", SKILL_NAMES[0]))).toBe(
      skillSourceDir(SKILL_NAMES[0]),
    );
  });

  test("unlinks a skill that no longer ships, and leaves the owner's own links and directories alone", async () => {
    const env = machine(["claude"]);
    const dir = join(env.HOME, ".claude", "skills");
    mkdirSync(join(dir, "their-dir"), { recursive: true });
    writeFileSync(join(dir, "their-dir", "keep.txt"), "owner data");
    symlinkSync(join(SKILLS, "dim-retired"), join(dir, "dim-retired"));
    symlinkSync(join(env.HOME, "elsewhere"), join(dir, "theirs"));

    installSkill(env);
    expect(lstatSync(join(dir, "dim-retired"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(dir, "theirs")).isSymbolicLink()).toBe(true);
    await expect(Bun.file(join(dir, "their-dir", "keep.txt")).text()).resolves.toBe("owner data");
  });

  test("skills install retires a stale link when every current skill is already linked", () => {
    const env = machine(["claude"]);
    installSkill(env);
    const stale = join(env.HOME, ".claude", "skills", "dim-retired");
    symlinkSync(join(SKILLS, "dim-retired"), stale);

    const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "skills", "install"], {
      env: { HOME: env.HOME, PATH: `${env.PATH}:${process.env.PATH}` },
    });
    expect(run.exitCode).toBe(0);
    expect(lstatSync(stale, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("every relative link in an installed skill resolves from where it is installed", () => {
    const env = machine(["claude"]);
    installSkill(env);
    const [dir] = skillLinkDirs(env);
    invariant(dir !== undefined, "a machine with harnesses has skill dirs");
    const unresolved = SKILL_NAMES.flatMap((name) => {
      const skill = join(dir, name);
      return [...new Glob("**/*.md").scanSync({ cwd: skill, followSymlinks: true })].flatMap((file) => {
        const from = dirname(join(skill, file));
        return [...readFileSync(join(skill, file), "utf8").matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
          .flatMap((match) => match[1] ?? [])
          .filter((target) => !/^[a-z]+:/.test(target))
          .filter((target) => !existsSync(join(from, target)))
          .map((target) => `${name}/${file} -> ${target}`);
      });
    });
    expect(unresolved).toEqual([]);
  });

  test("moves aside a skill already at that name rather than removing it", () => {
    const env = machine(["claude"]);
    const link = join(env.HOME, ".claude", "skills", SKILL_NAMES[0]);
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "the owner's own skill");
    expect(planSkill(env).find((p) => p.link === link)?.state).toBe("occupied");

    installSkill(env);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(Bun.file(`${link}.dim-backup/SKILL.md`).size).toBeGreaterThan(0);
  });

  test("preserves an earlier backup when replacing an occupied skill", async () => {
    const env = machine(["claude"]);
    const link = join(env.HOME, ".claude", "skills", SKILL_NAMES[0]);
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "current skill");
    writeFileSync(`${link}.dim-backup`, "earlier backup");

    expect(planSkill(env).find((p) => p.link === link)).toMatchObject({
      state: "occupied",
      backup: `${link}.dim-backup-2`,
    });
    installSkill(env);

    expect(await Bun.file(`${link}.dim-backup`).text()).toBe("earlier backup");
    expect(await Bun.file(`${link}.dim-backup-2/SKILL.md`).text()).toBe("current skill");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("leaves an occupied skill untouched while another installer holds the lock", async () => {
    const env = machine(["claude"]);
    const link = join(env.HOME, ".claude", "skills", SKILL_NAMES[0]);
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "owner skill");
    withPathLock(join(env.HOME, ".local", "state", "dim-factory", "locks", "skill-install"), () => {
      expect(() => installSkill(env)).toThrow(expect.objectContaining({ code: "lock_held" }));
    });
    await expect(Bun.file(join(link, "SKILL.md")).text()).resolves.toBe("owner skill");
    expect(existsSync(`${link}.dim-backup`)).toBe(false);
  });
});

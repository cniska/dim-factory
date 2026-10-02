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
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

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
    const named = [...new Glob("**/*.md").scanSync({ cwd: SKILLS, followSymlinks: false })].flatMap((file) =>
      [...readFileSync(join(SKILLS, file), "utf8").matchAll(/`(dim-[a-z]+)`/g)].map((match) => match[1]),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !shipped().includes(name as string))).toEqual([]);
  });

  test("installs every skill directory in the repo, so a new one is not left behind", () => {
    const dirs = readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(SKILLS, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
    expect(shipped()).toEqual(dirs);
  });

  test("links every skill into the skill directory of each installed harness", () => {
    const env = machine(["claude", "codex"]);
    expect(skillLinkDirs(env)).toEqual([
      join(env.HOME, ".agents", "skills"),
      join(env.HOME, ".claude", "skills"),
    ]);
    expect(planSkill(env).every((p) => p.state === "missing")).toBe(true);
    installSkill(env);
    for (const dir of skillLinkDirs(env)) {
      for (const name of SKILL_NAMES) {
        expect(readlinkSync(join(dir, name))).toBe(skillSourceDir(name));
      }
    }
    expect(planSkill(env).every((p) => p.state === "linked")).toBe(true);
  });

  test("links nothing for a harness that is not installed", () => {
    const env = machine(["claude"]);
    expect(skillLinkDirs(env)).toEqual([join(env.HOME, ".claude", "skills")]);
    installSkill(env);
    expect(existsSync(join(env.HOME, ".agents", "skills"))).toBe(false);
    expect(planSkill(env).every((p) => p.state === "linked")).toBe(true);
  });

  test("links once where two harnesses' skill directories are the same directory", () => {
    const env = machine(["claude", "codex"]);
    mkdirSync(join(env.HOME, ".agents", "skills"), { recursive: true });
    mkdirSync(join(env.HOME, ".claude"));
    symlinkSync(join(env.HOME, ".agents", "skills"), join(env.HOME, ".claude", "skills"));
    expect(skillLinkDirs(env)).toHaveLength(1);
    installSkill(env);
    expect(readlinkSync(join(env.HOME, ".claude", "skills", SKILL_NAMES[0]))).toBe(
      skillSourceDir(SKILL_NAMES[0]),
    );
  });

  test("links once where one harness's skill directory is a link to the other's that does not exist yet", () => {
    const env = machine(["claude", "codex"]);
    mkdirSync(join(env.HOME, ".claude"));
    symlinkSync("../.agents/skills", join(env.HOME, ".claude", "skills"));
    expect(skillLinkDirs(env)).toHaveLength(1);
    installSkill(env);
    expect(readlinkSync(join(env.HOME, ".agents", "skills", SKILL_NAMES[0]))).toBe(
      skillSourceDir(SKILL_NAMES[0]),
    );
  });

  test("a skill linked for one harness still leaves the other pending", () => {
    const env = machine(["claude", "codex"]);
    const [first] = skillLinkDirs(env);
    mkdirSync(first as string, { recursive: true });
    const name = SKILL_NAMES[0];
    symlinkSync(skillSourceDir(name), join(first as string, name));
    const pending = planSkill(env).filter((p) => p.state !== "linked");
    expect(pending.some((p) => p.name === name)).toBe(true);
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
    const env = machine(["codex"]);
    installSkill(env);
    const stale = join(env.HOME, ".agents", "skills", "dim-retired");
    symlinkSync(join(SKILLS, "dim-retired"), stale);

    const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "skills", "install"], {
      env: { ...process.env, HOME: env.HOME, PATH: `${env.PATH}:${process.env.PATH}` },
    });
    expect(run.exitCode).toBe(0);
    expect(lstatSync(stale, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("every relative link in an installed skill resolves from where it is installed", () => {
    const env = machine(["claude"]);
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

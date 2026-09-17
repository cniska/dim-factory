import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a repo says to run, read rather than inferred. Running the repo's own
 * task is what makes a local check the same check CI runs, so a detector that
 * reaches past the declared script to the tool underneath would name
 * `biome check` where the repo's script is `biome format`, and `bun test` where
 * the gate is `bun run verify`.
 */
export type Task = { name: string; command: string; source: string };

/** The lock file names the package manager; the manifest alone does not. */
const LOCKS: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function packageManager(repo: string): string {
  for (const [lock, pm] of LOCKS) if (existsSync(join(repo, lock))) return pm;
  return "npm";
}

function fromPackageJson(repo: string): Task[] {
  const path = join(repo, "package.json");
  if (!existsSync(path)) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const pm = packageManager(repo);
  return Object.keys(scripts).map((name) => ({
    name,
    command: `${pm} run ${name}`,
    source: "package.json",
  }));
}

function fromMise(repo: string): Task[] {
  const path = join(repo, "mise.toml");
  if (!existsSync(path)) return [];
  let parsed: { tasks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch {
    return [];
  }
  return Object.keys(parsed.tasks ?? {}).map((name) => ({
    name,
    command: `mise run ${name}`,
    source: "mise.toml",
  }));
}

/** A target is a line-initial name before a colon; `.PHONY` and pattern rules are not targets. */
const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(repo: string): Task[] {
  const path = join(repo, "Makefile");
  if (!existsSync(path)) return [];
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      tasks.push({ name, command: `make ${name}`, source: "Makefile" });
    }
  }
  return tasks;
}

export function declaredTasks(repo: string): Task[] {
  return [...fromPackageJson(repo), ...fromMise(repo), ...fromMakefile(repo)];
}

/**
 * The one task that stands for "this change is sound". Named in preference
 * order, because a repo that declares both `verify` and `test` means the wider
 * one — `bun run verify` here runs lint, types, tests and the shell suite, and
 * gating on `test` alone would pass a change that does not compile.
 */
const CHECK_ORDER = ["verify", "check", "ci", "validate", "test"];

export function checkTask(repo: string): Task | null {
  const tasks = declaredTasks(repo);
  for (const name of CHECK_ORDER) {
    const found = tasks.find((t) => t.name === name);
    if (found) return found;
  }
  return null;
}

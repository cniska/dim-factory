import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LONGEST_MANIFEST = 1024 * 1024;

export function readManifest(path: string): string | null {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null;
  }
  if (size > LONGEST_MANIFEST) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

type DeclaredTask = { name: string; commandLine: string; source: string };

const LOCKS: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function managerOf(repo: string): string | null {
  for (const [lock, pm] of LOCKS) if (existsSync(join(repo, lock))) return pm;
  return null;
}

function fromPackageJson(repo: string): DeclaredTask[] {
  const text = readManifest(join(repo, "package.json"));
  if (text === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const pm = managerOf(repo);
  if (pm === null) return [];
  return Object.keys(scripts).map((name) => ({
    name,
    commandLine: `${pm} run ${name}`,
    source: "package.json",
  }));
}

function fromMise(repo: string): DeclaredTask[] {
  const text = readManifest(join(repo, "mise.toml"));
  if (text === null) return [];
  let parsed: { tasks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  return Object.keys(parsed.tasks ?? {}).map((name) => ({
    name,
    commandLine: `mise run ${name}`,
    source: "mise.toml",
  }));
}

const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(repo: string): DeclaredTask[] {
  const text = readManifest(join(repo, "Makefile"));
  if (text === null) return [];
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name) names.add(name);
  }
  return [...names].map((name) => ({ name, commandLine: `make ${name}`, source: "Makefile" }));
}

const CHECK_ORDER = ["verify", "check", "ci", "validate", "test"];

const FORMAT_ORDER = ["format", "fmt"];

function firstDeclared(repo: string, order: string[]): DeclaredTask | null {
  const tasks = [...fromPackageJson(repo), ...fromMise(repo), ...fromMakefile(repo)];
  for (const name of order) {
    const found = tasks.find((one) => one.name === name);
    if (found) return found;
  }
  return null;
}

export function checkTask(repo: string): DeclaredTask | null {
  return firstDeclared(repo, CHECK_ORDER);
}

export function formatTask(repo: string): DeclaredTask | null {
  return firstDeclared(repo, FORMAT_ORDER);
}

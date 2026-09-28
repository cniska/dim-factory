import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { committedTree } from "./git-committed";
import { trunkRef } from "./git-trunk";

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

export type WorkspaceTask = { name: string; commandLine: string; source: string };

type DeclaredTask = WorkspaceTask & { definition: string };

type Manifests = { read(name: string): string | null; has(name: string): boolean };

const LOCKS: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const MANIFESTS = ["package.json", "mise.toml", "Makefile", ...LOCKS.map(([lock]) => lock)];

function onDisk(repo: string): Manifests {
  return { read: (name) => readManifest(join(repo, name)), has: (name) => existsSync(join(repo, name)) };
}

function committed(repo: string, at: string): Manifests {
  const tree = committedTree(repo, at, MANIFESTS);
  if (!tree) throw new Error(`cannot read ${at} in ${repo}: it names no commit`);
  return { has: (name) => tree.has(name), read: (name) => tree.read(name, LONGEST_MANIFEST) };
}

function managerOf(manifests: Manifests): string | null {
  for (const [lock, pm] of LOCKS) if (manifests.has(lock)) return pm;
  return null;
}

export function packageManager(repo: string): string | null {
  return managerOf(onDisk(repo));
}

function fromPackageJson(manifests: Manifests): DeclaredTask[] {
  const text = manifests.read("package.json");
  if (text === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const pm = managerOf(manifests);
  if (pm === null) return [];
  return Object.entries(scripts).map(([name, script]) => ({
    name,
    commandLine: `${pm} run ${name}`,
    source: "package.json",
    definition: JSON.stringify(script),
  }));
}

function fromMise(manifests: Manifests): DeclaredTask[] {
  const text = manifests.read("mise.toml");
  if (text === null) return [];
  let parsed: { tasks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  return Object.entries(parsed.tasks ?? {}).map(([name, task]) => ({
    name,
    commandLine: `mise run ${name}`,
    source: "mise.toml",
    definition: JSON.stringify(task),
  }));
}

const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(manifests: Manifests): DeclaredTask[] {
  const text = manifests.read("Makefile");
  if (text === null) return [];
  const rules = new Map<string, string[]>();
  let rule: string[] | null = null;
  for (const line of text.split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name) {
      rule = rules.get(name) ?? [];
      rules.set(name, rule);
      rule.push(line);
    } else if (rule && line.startsWith("\t")) {
      rule.push(line);
    } else {
      rule = null;
    }
  }
  return [...rules].map(([name, lines]) => ({
    name,
    commandLine: `make ${name}`,
    source: "Makefile",
    definition: lines.join("\n"),
  }));
}

function declared(manifests: Manifests): DeclaredTask[] {
  return [...fromPackageJson(manifests), ...fromMise(manifests), ...fromMakefile(manifests)];
}

function workspaceTask({ name, commandLine, source }: DeclaredTask): WorkspaceTask {
  return { name, commandLine, source };
}

export function declaredTasks(repo: string): WorkspaceTask[] {
  return declared(onDisk(repo)).map(workspaceTask);
}

const CHECK_ORDER = ["verify", "check", "ci", "validate", "test"];

const FORMAT_ORDER = ["format", "fmt"];

function firstDeclared(manifests: Manifests, order: string[]): DeclaredTask | null {
  const tasks = declared(manifests);
  for (const name of order) {
    const found = tasks.find((one) => one.name === name);
    if (found) return found;
  }
  return null;
}

export function checkTask(repo: string): WorkspaceTask | null {
  const found = firstDeclared(onDisk(repo), CHECK_ORDER);
  return found && workspaceTask(found);
}

export function formatTask(repo: string): WorkspaceTask | null {
  const found = firstDeclared(onDisk(repo), FORMAT_ORDER);
  return found && workspaceTask(found);
}

export type TrunkCheck =
  | { task: WorkspaceTask }
  | { refused: "undeclared"; trunk: string }
  | { refused: "redefined"; trunk: string; task: WorkspaceTask };

export function trunkCheck(worktree: string): TrunkCheck {
  const trunk = trunkRef(worktree);
  const governing = firstDeclared(committed(worktree, trunk), CHECK_ORDER);
  if (!governing) return { refused: "undeclared", trunk };
  const task = workspaceTask(governing);
  const here = declared(onDisk(worktree)).find(
    (one) => one.source === governing.source && one.name === governing.name,
  );
  if (!here || here.commandLine !== governing.commandLine || here.definition !== governing.definition) {
    return { refused: "redefined", trunk, task };
  }
  return { task };
}

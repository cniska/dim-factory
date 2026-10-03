import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { refuser } from "./coded-error";
import { type CommittedTree, committedTree } from "./git-committed";

const LONGEST_MANIFEST = 1024 * 1024;

type Read =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "text"; readonly text: string };

function readRegularFile(path: string): Read {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { kind: "absent" };
    size = stat.size;
  } catch {
    return { kind: "absent" };
  }
  if (size > LONGEST_MANIFEST) return { kind: "absent" };
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "unreadable" };
  }
}

export function readManifest(path: string): string | null {
  const read = readRegularFile(path);
  return read.kind === "text" ? read.text : null;
}

export const refuseManifest = refuser<{
  readonly manifest_unreadable: { readonly path: string };
  readonly manifest_unparseable: { readonly file: string; readonly detail: string };
}>({
  manifest_unreadable: {
    message: ({ path }) => `${path} is there but cannot be read, so what the repo declares is unknown`,
    resolve: ({ path }) => `stop and hand this error to the owner: ${path} must be a readable regular file`,
  },
  manifest_unparseable: {
    message: ({ file, detail }) => `${file} does not parse, so what the repo declares is unknown: ${detail}`,
    resolve: ({ file }) => `stop and hand this error to the owner: ${file} must parse`,
  },
});

export type Manifests = CommittedTree;

export function manifestsIn(repo: string): Manifests {
  return {
    has: (file) => existsSync(join(repo, file)),
    read(file) {
      const path = join(repo, file);
      const read = readRegularFile(path);
      if (read.kind === "unreadable") throw refuseManifest("manifest_unreadable", { path });
      return read.kind === "text" ? read.text : null;
    },
  };
}

const LOCKS: readonly (readonly [string, string])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const MANIFESTS = ["package.json", "mise.toml", "Makefile", ...LOCKS.map(([lock]) => lock)];

export function manifestsAt(root: string, at: string): Manifests | null {
  return committedTree(root, at, MANIFESTS);
}

export type DeclaredTask = {
  readonly name: string;
  readonly commandLine: string;
  readonly source: string;
  readonly body: string;
};

function managerOf(manifests: Manifests): string | null {
  for (const [lock, pm] of LOCKS) if (manifests.has(lock)) return pm;
  return null;
}

const readText = (manifests: Manifests, file: string) => manifests.read(file, LONGEST_MANIFEST);

function fromPackageJson(manifests: Manifests): DeclaredTask[] {
  const text = readText(manifests, "package.json");
  if (text === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch (error) {
    throw refuseManifest("manifest_unparseable", { file: "package.json", detail: String(error) });
  }
  const pm = managerOf(manifests);
  if (pm === null) return [];
  const body = JSON.stringify(scripts);
  return Object.keys(scripts).map((name) => ({
    name,
    commandLine: `${pm} run ${name}`,
    source: "package.json",
    body,
  }));
}

function fromMise(manifests: Manifests): DeclaredTask[] {
  const text = readText(manifests, "mise.toml");
  if (text === null) return [];
  let parsed: { tasks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(text) as typeof parsed;
  } catch (error) {
    throw refuseManifest("manifest_unparseable", { file: "mise.toml", detail: String(error) });
  }
  const tasks = parsed.tasks ?? {};
  const body = JSON.stringify(tasks);
  return Object.keys(tasks).map((name) => ({
    name,
    commandLine: `mise run ${name}`,
    source: "mise.toml",
    body,
  }));
}

const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(manifests: Manifests): DeclaredTask[] {
  const text = readText(manifests, "Makefile");
  if (text === null) return [];
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name) names.add(name);
  }
  return [...names].map((name) => ({ name, commandLine: `make ${name}`, source: "Makefile", body: text }));
}

const CHECK_ORDER = ["verify", "check", "ci", "validate", "test"];

const FORMAT_ORDER = ["format", "fmt"];

function firstDeclared(manifests: Manifests, order: readonly string[]): DeclaredTask | null {
  const tasks = [...fromPackageJson(manifests), ...fromMise(manifests), ...fromMakefile(manifests)];
  for (const name of order) {
    const found = tasks.find((one) => one.name === name);
    if (found) return found;
  }
  return null;
}

export function checkDeclared(manifests: Manifests): DeclaredTask | null {
  return firstDeclared(manifests, CHECK_ORDER);
}

export function checkTask(repo: string): DeclaredTask | null {
  return checkDeclared(manifestsIn(repo));
}

export function formatTask(repo: string): DeclaredTask | null {
  return firstDeclared(manifestsIn(repo), FORMAT_ORDER);
}

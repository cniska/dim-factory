import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodedError } from "./coded-error";
import { committedTree } from "./git-committed";

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

export type Manifests = { read(file: string): string | null };

export function manifestsIn(repo: string): Manifests {
  return {
    read(file) {
      const path = join(repo, file);
      const read = readRegularFile(path);
      if (read.kind === "unreadable") {
        throw new CodedError(
          "manifest_unreadable",
          `${path} is there but cannot be read, so what the repo declares is unknown`,
          { path },
          "dim doctor",
        );
      }
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
  const tree = committedTree(root, at, MANIFESTS);
  if (tree === null) return null;
  return { read: (file) => (tree.has(file) ? (tree.read(file, LONGEST_MANIFEST) ?? "") : null) };
}

export type DeclaredTask = {
  readonly name: string;
  readonly commandLine: string;
  readonly source: string;
  readonly body: string;
};

function managerOf(manifests: Manifests): string | null {
  for (const [lock, pm] of LOCKS) if (manifests.read(lock) !== null) return pm;
  return null;
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
  return Object.entries(scripts).map(([name, body]) => ({
    name,
    commandLine: `${pm} run ${name}`,
    source: "package.json",
    body: JSON.stringify(body),
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
  return Object.entries(parsed.tasks ?? {}).map(([name, body]) => ({
    name,
    commandLine: `mise run ${name}`,
    source: "mise.toml",
    body: JSON.stringify(body),
  }));
}

const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(manifests: Manifests): DeclaredTask[] {
  const text = manifests.read("Makefile");
  if (text === null) return [];
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name !== undefined) {
      current = bodies.get(name) ?? [];
      bodies.set(name, current);
      current.push(line);
    } else if (current !== null && line.startsWith("\t")) {
      current.push(line);
    } else {
      current = null;
    }
  }
  return [...bodies].map(([name, lines]) => ({
    name,
    commandLine: `make ${name}`,
    source: "Makefile",
    body: lines.join("\n"),
  }));
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

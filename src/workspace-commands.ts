import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * These paths are read by a `SessionStart` hook, so the file at one of them is
 * whatever the working directory happens to hold. A FIFO named `Makefile` blocks
 * the read forever and takes the session start with it; a directory throws. Only
 * a regular file is opened, and only its first bytes: a manifest is kilobytes,
 * and anything claiming to be one at this size is not being read either way.
 */
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

/**
 * What a repo says to run, read rather than inferred. Running what the workspace
 * declares is what makes a local check the same check CI runs, so a detector that
 * reaches past the declared script to the tool underneath would name
 * `biome check` where the repo's script is `biome format`, and `bun test` where
 * the gate is `bun run verify`.
 */
export type WorkspaceCommand = { name: string; command: string; source: string };

/** The lock file names the package manager; the manifest alone does not. */
const LOCKS: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function packageManager(repo: string): string | null {
  for (const [lock, pm] of LOCKS) if (existsSync(join(repo, lock))) return pm;
  return null;
}

function fromPackageJson(repo: string): WorkspaceCommand[] {
  const text = readManifest(join(repo, "package.json"));
  if (text === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  // The script is only half of what the repo declares; without the lock file
  // naming a runner there is no command to state, and stating one anyway is the
  // inference this whole module exists to avoid.
  const pm = packageManager(repo);
  if (pm === null) return [];
  return Object.keys(scripts).map((name) => ({
    name,
    command: `${pm} run ${name}`,
    source: "package.json",
  }));
}

function fromMise(repo: string): WorkspaceCommand[] {
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
    command: `mise run ${name}`,
    source: "mise.toml",
  }));
}

/** A target is a line-initial name before a colon; `.PHONY` and pattern rules are not targets. */
const MAKE_TARGET = /^([A-Za-z][\w-]*)\s*:(?!=)/;

function fromMakefile(repo: string): WorkspaceCommand[] {
  const text = readManifest(join(repo, "Makefile"));
  if (text === null) return [];
  const commands: WorkspaceCommand[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const name = MAKE_TARGET.exec(line)?.[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      commands.push({ name, command: `make ${name}`, source: "Makefile" });
    }
  }
  return commands;
}

export function declaredCommands(repo: string): WorkspaceCommand[] {
  return [...fromPackageJson(repo), ...fromMise(repo), ...fromMakefile(repo)];
}

/**
 * The one command that stands for "this change is sound". Named in preference
 * order, because a repo that declares both `verify` and `test` means the wider
 * one — `bun run verify` here runs lint, types, tests and the shell suite, and
 * gating on `test` alone would pass a change that does not compile.
 */
const CHECK_ORDER = ["verify", "check", "ci", "validate", "test"];

/**
 * Narrower than the check on purpose. `lint` is not here: a repo that declares
 * both means a different thing by each, and a session told to run the linter
 * where it meant to reformat writes a diff the author did not ask for.
 */
const FORMAT_ORDER = ["format", "fmt"];

function firstDeclared(repo: string, order: string[]): WorkspaceCommand | null {
  const commands = declaredCommands(repo);
  for (const name of order) {
    const found = commands.find((one) => one.name === name);
    if (found) return found;
  }
  return null;
}

export function checkCommand(repo: string): WorkspaceCommand | null {
  return firstDeclared(repo, CHECK_ORDER);
}

export function formatCommand(repo: string): WorkspaceCommand | null {
  return firstDeclared(repo, FORMAT_ORDER);
}

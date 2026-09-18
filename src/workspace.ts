import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkoutRoot } from "./checkout";
import { checkTask, declaredTasks, formatTask, packageManager, type Task } from "./tasks";
import { worktreeOf } from "./worktree";

export type WorkspaceMember = { path: string; source: string };
export type WorkerHook = { path: string; argv: string[] };
/** A repository's own answer and the file it answered in; `null` where it did not answer. */
export type Declaration<T> = { value: T; source: string };
export type WorkspaceContract = {
  checkoutRoot: string;
  worktree: { path: string; name: string | null; branch: string | null };
  languages: string[];
  ecosystems: string[];
  packageManagers: string[];
  members: WorkspaceMember[];
  tasks: Task[];
  checkTask: Task | null;
  formatTask: Task | null;
  bootstrap: { command: string[]; source: string } | null;
  capabilities: { format: boolean; analyze: boolean; test: boolean };
  services: Declaration<string[]> | null;
  environment: Declaration<string[]> | null;
  setup: WorkerHook | null;
  teardown: WorkerHook | null;
};
export type WorkspaceProfile = Omit<WorkspaceContract, "worktree">;

function manifest(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function pubspecFacts(root: string): {
  kind: "dart" | "flutter";
  members: WorkspaceMember[];
} | null {
  const text = manifest(join(root, "pubspec.yaml"));
  if (text === null) return null;
  const flutter = /^\s+flutter:\s*$/m.test(text) && /^\s+sdk:\s+flutter\s*$/m.test(text);
  const members: WorkspaceMember[] = [];
  let inWorkspace = false;
  for (const line of text.split("\n")) {
    if (/^workspace:\s*$/.test(line)) {
      inWorkspace = true;
      continue;
    }
    if (inWorkspace && /^\s+-\s+([^#]+?)\s*$/.exec(line)?.[1]) {
      const path = /^\s+-\s+([^#]+?)\s*$/.exec(line)?.[1]?.trim();
      if (path) members.push({ path, source: "pubspec.yaml" });
      continue;
    }
    if (inWorkspace && /^(?:[^\s:#][^:]*):(?:\s.*)?$/.test(line)) inWorkspace = false;
  }
  return { kind: flutter ? "flutter" : "dart", members };
}

/** Compose's own precedence, so a repository keeping a legacy name beside the current one gets the current one. */
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Service names only: an image, a port or a `depends_on` edge is a topology the
 * repository's setup hook owns, and a profile repeating one asserts a port no
 * hook allocated. A file that cannot be read as a mapping returns `null` rather
 * than an empty list, because an empty list is the repository saying it needs no
 * services and a parse this module gave up on is not the repository saying anything.
 */
function declaredServices(root: string): Declaration<string[]> | null {
  for (const file of COMPOSE_FILES) {
    const text = manifest(join(root, file));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch {
      return null;
    }
    if (!isMapping(parsed)) return null;
    const services = parsed.services;
    if (services === undefined || services === null) return { value: [], source: file };
    if (!isMapping(services)) return null;
    return { value: Object.keys(services), source: file };
  }
  return null;
}

/**
 * The sample files a repository tracks. `.env` itself is never among them: it is
 * the filled-in copy, it is gitignored precisely because it holds the secrets,
 * and a profile that opened it would carry a credential into a job report.
 */
const ENVIRONMENT_SAMPLES = [".env.example", ".env.sample", ".env.template"];

const ENVIRONMENT_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * A sample file is tracked and so is meant to hold placeholders, but repositories
 * do commit a real value by mistake — which is why no part of one is recorded, and
 * why a value quoted across several lines is followed to its closing quote. Read
 * line by line without that, a PEM body's base64 matches the shape of a name, and
 * a chunk of the key ends up in the profile as one.
 */
function declaredEnvironment(root: string): Declaration<string[]> | null {
  for (const file of ENVIRONMENT_SAMPLES) {
    const text = manifest(join(root, file));
    if (text === null) continue;
    const names: string[] = [];
    let unclosed: string | null = null;
    for (const line of text.split("\n")) {
      if (unclosed !== null) {
        if (line.includes(unclosed)) unclosed = null;
        continue;
      }
      const declaration = ENVIRONMENT_NAME.exec(line);
      if (declaration === null) continue;
      const value = line.slice(declaration[0].length).trimStart();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && !value.slice(1).includes(quote)) unclosed = quote;
      const name = declaration[1] as string;
      if (!names.includes(name)) names.push(name);
    }
    return { value: names, source: file };
  }
  return null;
}

function declaredCapability(tasks: Task[], names: string[]): boolean {
  return tasks.some((task) => names.includes(task.name));
}

function gitBranch(root: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", root, "symbolic-ref", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!proc.success) return null;
  const branch = new TextDecoder().decode(proc.stdout).trim();
  return branch || null;
}

function hook(root: string, name: string): WorkerHook | null {
  const path = join(root, "scripts", name);
  try {
    if (!statSync(path).isFile()) return null;
    return { path, argv: [path] };
  } catch {
    return null;
  }
}

export function workspaceContract(dir: string): WorkspaceContract | null {
  const root = checkoutRoot(resolve(dir));
  if (root === null) return null;
  const tasks = declaredTasks(root);
  const pubspec = pubspecFacts(root);
  const hasPackageJson = manifest(join(root, "package.json")) !== null;
  const manager = packageManager(root);
  const packageManagers = manager ? [manager] : [];
  if (pubspec) packageManagers.push(pubspec.kind);
  const languages = [...(pubspec ? ["dart"] : []), ...(hasPackageJson ? ["javascript"] : [])];
  const ecosystems = [...(pubspec ? [pubspec.kind] : []), ...(hasPackageJson ? ["node"] : [])];
  const bootstrap = pubspec ? { command: [pubspec.kind, "pub", "get"], source: "pubspec.yaml" } : null;
  return {
    checkoutRoot: root,
    worktree: { path: root, name: worktreeOf(root), branch: gitBranch(root) },
    languages,
    ecosystems,
    packageManagers,
    members: pubspec?.members ?? [],
    tasks,
    checkTask: checkTask(root),
    formatTask: formatTask(root),
    bootstrap,
    capabilities: {
      format: declaredCapability(tasks, ["format", "fmt"]),
      analyze: declaredCapability(tasks, ["analyze", "analyse"]),
      test: declaredCapability(tasks, ["test", "tests"]),
    },
    services: declaredServices(root),
    environment: declaredEnvironment(root),
    setup: hook(root, "worktree-setup.sh"),
    teardown: hook(root, "worktree-teardown.sh"),
  };
}

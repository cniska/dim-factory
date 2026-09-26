import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkoutRoot } from "./git-checkout";
import { detectWorkspace } from "./workspace-detectors";
import { checkTask, declaredTasks, formatTask, readManifest, type WorkspaceTask } from "./workspace-tasks";
import { worktreeOf } from "./worktree";

export type WorkspaceMember = { path: string; source: string };
export type WorkerHook = { path: string; argv: string[] };
export type Declaration<T> = { value: T; source: string };
export type WorkspaceContract = {
  checkoutRoot: string;
  worktree: { path: string; name: string | null; branch: string | null };
  languages: string[];
  ecosystems: string[];
  packageManagers: string[];
  members: WorkspaceMember[];
  tasks: WorkspaceTask[];
  checkTask: WorkspaceTask | null;
  formatTask: WorkspaceTask | null;
  bootstrap: Declaration<string[]> | null;
  capabilities: { format: boolean; analyze: boolean; test: boolean };
  services: Declaration<string[]> | null;
  requiredEnvironment: Declaration<string[]> | null;
  setup: WorkerHook | null;
  teardown: WorkerHook | null;
};
export type WorkspaceProfile = Omit<WorkspaceContract, "worktree">;

function pubspecFacts(root: string): {
  kind: "dart" | "flutter";
  members: WorkspaceMember[];
} | null {
  const text = readManifest(join(root, "pubspec.yaml"));
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

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredServices(root: string): Declaration<string[]> | null {
  for (const file of COMPOSE_FILES) {
    const text = readManifest(join(root, file));
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

const ENVIRONMENT_SAMPLES = [".env.example", ".env.sample", ".env.template"];

const ENVIRONMENT_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function declaredEnvironment(root: string): Declaration<string[]> | null {
  for (const file of ENVIRONMENT_SAMPLES) {
    const text = readManifest(join(root, file));
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

function declaredCapability(tasks: WorkspaceTask[], names: string[]): boolean {
  return tasks.some((one) => names.includes(one.name));
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
  const detected = detectWorkspace(root);
  const detectedTasks = detected?.tasks ?? [];
  const pubspec = pubspecFacts(root);
  const packageManagers = detected?.packageManagers ?? [];
  const languages = [...(detected?.languages ?? [])];
  const ecosystems = [...(detected?.ecosystems ?? [])];
  const bootstrap = pubspec ? { value: [pubspec.kind, "pub", "get"], source: "pubspec.yaml" } : null;
  return {
    checkoutRoot: root,
    worktree: { path: root, name: worktreeOf(root), branch: gitBranch(root) },
    languages,
    ecosystems,
    packageManagers: [...packageManagers],
    members: pubspec?.members ?? [],
    tasks: [...tasks, ...detectedTasks],
    checkTask: checkTask(root),
    formatTask: formatTask(root),
    bootstrap,
    capabilities: {
      format: declaredCapability(tasks, ["format", "fmt"]),
      analyze: declaredCapability(tasks, ["analyze", "analyse"]),
      test: declaredCapability(tasks, ["test", "tests"]),
    },
    services: declaredServices(root),
    requiredEnvironment: declaredEnvironment(root),
    setup: hook(root, "worktree-setup.sh"),
    teardown: hook(root, "worktree-teardown.sh"),
  };
}

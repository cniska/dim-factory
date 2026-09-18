import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkoutRoot } from "./checkout";
import { checkTask, declaredTasks, formatTask, packageManager, type Task } from "./tasks";
import { worktreeOf } from "./worktree";

export type WorkspaceMember = { path: string; source: string };
export type WorkerHook = { path: string; argv: string[] };
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
    setup: hook(root, "worktree-setup.sh"),
    teardown: hook(root, "worktree-teardown.sh"),
  };
}

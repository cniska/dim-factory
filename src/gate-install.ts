import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, GATE_ERROR, GATE_HOOKS } from "./gate-contract";
import { hookBody, hookOwners } from "./gate-hooks";
import { type Env, resolveHomeDir } from "./paths";

type InstalledHook = {
  readonly name: string;
  readonly path: string;
  readonly state: "installed" | "missing" | "stale";
};

export type GatePlan = {
  readonly hooks: readonly InstalledHook[];
  readonly globalHooksPath: string | null;
  readonly strandedCopies: readonly string[];
};

const KEY_UNSET = 1;

export function sharedHooksDir(env: Env): string {
  return join(resolveHomeDir(env), ".config", "dim", "hooks");
}

function gitConfig(args: readonly string[], cwd: string | undefined, env: Env) {
  return spawnSync("git", ["config", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function unreadable(args: readonly string[], cwd: string | undefined, ran: ReturnType<typeof gitConfig>) {
  return fail(GATE_ERROR.gitConfigUnreadable, {
    args: args.join(" "),
    root: cwd ?? "the global config",
    detail: ran.stderr?.trim() || ran.error?.message || `exit ${ran.status}`,
  });
}

export function gitConfigValue(args: readonly string[], cwd: string | undefined, env: Env): string | null {
  const read = gitConfig(args, cwd, env);
  if (read.status === KEY_UNSET) return null;
  if (read.status !== 0) throw unreadable(args, cwd, read);
  return read.stdout.trim() || null;
}

function globalHooksPath(env: Env): string | null {
  return gitConfigValue(["--global", "--get", "core.hooksPath"], undefined, env);
}

function stateOf(path: string, body: string): InstalledHook["state"] {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === body ? "installed" : "stale";
}

const strandedCopies = (repos: readonly string[]) =>
  repos.map((repo) => join(repo, ".git", "hooks", "commit-msg")).filter(existsSync);

export function planCommitGate(owners: readonly string[], strandedIn: readonly string[], env: Env): GatePlan {
  const dir = sharedHooksDir(env);
  const body = hookBody(owners);
  return {
    hooks: GATE_HOOKS.map((name) => ({ name, path: join(dir, name), state: stateOf(join(dir, name), body) })),
    globalHooksPath: globalHooksPath(env),
    strandedCopies: strandedCopies(strandedIn),
  };
}

export function installCommitGate(
  owners: readonly string[],
  strandedIn: readonly string[],
  env: Env,
): GatePlan {
  const dir = sharedHooksDir(env);
  const existing = globalHooksPath(env);
  if (existing !== null && existing !== dir) throw fail(GATE_ERROR.hooksPathTaken, { existing });

  mkdirSync(dir, { recursive: true });
  const body = hookBody(owners);
  const hooks = GATE_HOOKS.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return { name, path, state: "installed" as const };
  });
  const stranded = strandedCopies(strandedIn);
  for (const copy of stranded) rmSync(copy, { force: true });
  const args = ["--global", "core.hooksPath", dir];
  const wrote = gitConfig(args, undefined, env);
  if (wrote.status !== 0) throw unreadable(args, undefined, wrote);
  return { hooks, globalHooksPath: dir, strandedCopies: stranded };
}

export function installedOwners(env: Env): readonly string[] | null {
  return hookOwners(join(sharedHooksDir(env), "commit-msg"));
}

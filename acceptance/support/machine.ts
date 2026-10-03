import { afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resultOf } from "./dim-output";
import type { HarnessScript } from "./harness-script";
import { OperatorSession } from "./operator-session";
import {
  type Invocation,
  invocations,
  releasePath,
  signalPath,
  writeHarnessScript,
} from "./scripted-harness-state";
import type { StationRole } from "./vocabulary";
import { MACHINE_TEST_LIMIT_MS, waitFor } from "./wait";

export const CHECKOUT = join(import.meta.dir, "..", "..");

export const MODELS = {
  planner: "scripted-planner",
  builder: "scripted-builder",
  reviewer: "scripted-reviewer",
} as const;

export type Models = Readonly<Partial<Record<"default" | StationRole, string>>>;

export type MachineEnv = Readonly<Record<string, string>> & {
  readonly HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_DATA_HOME: string;
  readonly XDG_STATE_HOME: string;
  readonly TMPDIR: string;
  readonly PATH: string;
};

export type Machine = {
  readonly root: string;
  readonly env: MachineEnv;
  readonly home: string;
  readonly config: string;
  readonly record: string;
  readonly bin: string;
  readonly repo: string;
  readonly state: string;
  readonly operator: OperatorSession;
  script(script: HarnessScript): void;
  invocations(role?: StationRole): readonly Invocation[];
  invocation(role: StationRole, n: number): Invocation;
  reached(signal: string): Promise<number>;
  release(name: string): void;
  git(args: readonly string[], cwd?: string): string;
  onMain(path: string): boolean;
  commitsOn(branch: string): readonly string[];
  ownerCommits(path: string, content: string): void;
  userSettings(settings: Readonly<Record<string, unknown>>): void;
  projectSettings(settings: Readonly<Record<string, unknown>>): void;
  models(models: Models): void;
  createOperator(): OperatorSession;
  close(): void;
};

export type MachinePaths = { readonly root: string; readonly state: string };

const RECORD = ["dim-factory", "record"] as const;

export const RECORD_PROBE = `$XDG_DATA_HOME/${RECORD.join("/")}/planted`;

export const PROJECT_SETTINGS = { ship: "default-branch" } as const;

export type MachineOptions = {
  readonly script?: HarnessScript;
  readonly project?: string;
  readonly check?: string | ((paths: MachinePaths) => string);
  readonly ownerEnv?: Readonly<Record<string, string>>;
};

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function git(args: readonly string[], cwd: string): string {
  const ran = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.toString()}`);
  return ran.stdout.toString().trim();
}

function initRepo(repo: string, project: string, check: string): void {
  mkdirSync(join(repo, ".dim"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Owner"], repo);
  git(["config", "user.email", "owner@example.com"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  git(["remote", "add", "origin", `git@github.com:${project}.git`], repo);
  writeFileSync(join(repo, ".dim", "config.json"), `${JSON.stringify(PROJECT_SETTINGS)}\n`);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { verify: check } })}\n`);
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  writeFileSync(join(repo, "README.md"), "# widgets\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "chore: start"], repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo);
}

async function createMachine(options: MachineOptions): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), "dim-acceptance-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const xdg = { config: join(root, "config"), data: join(root, "data"), state: join(root, "state") };
  const config = join(xdg.config, "dim");
  const record = join(xdg.data, ...RECORD);
  const state = join(root, "harness");
  const repo = join(root, "repo");
  for (const dir of [bin, home, config, state]) mkdirSync(dir, { recursive: true });

  executable(join(bin, "dim"), `#!/bin/sh\nexec bun "${join(CHECKOUT, "src", "cli.ts")}" "$@"\n`);
  executable(
    join(bin, "claude"),
    `#!/bin/sh\nexec bun "${join(import.meta.dir, "scripted-claude.ts")}" "${state}" "$@"\n`,
  );

  const env: MachineEnv = {
    ...options.ownerEnv,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
  };
  let user: { readonly settings: Readonly<Record<string, unknown>>; readonly models: Models } = {
    settings: {},
    models: MODELS,
  };
  const writeUser = (next: typeof user) => {
    user = next;
    writeFileSync(
      join(config, "config.json"),
      `${JSON.stringify({ ...user.settings, models: user.models })}\n`,
    );
  };
  writeUser(user);
  const check =
    typeof options.check === "function" ? options.check({ root, state }) : (options.check ?? "true");
  initRepo(repo, options.project ?? "acme/widgets", check);
  writeHarnessScript(state, options.script ?? {});

  const operators: OperatorSession[] = [];
  const createOperator = () => {
    const session = OperatorSession.open(env, repo);
    operators.push(session);
    return session;
  };
  const operator = createOperator();
  resultOf(await operator.dim(["hooks", "install"]));
  await operator.fire("SessionStart");

  const inRepo = (args: readonly string[], cwd = repo) => git(args, cwd);
  const ownerCommits = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
    inRepo(["add", path]);
    inRepo(["commit", "-q", "-m", `chore: owner edits ${path}`]);
  };
  const ofRole = (role?: StationRole) =>
    invocations(state).filter((call) => role === undefined || call.role === role);
  return {
    root,
    env,
    home,
    config,
    record,
    bin,
    repo,
    state,
    operator,
    script: (script) => writeHarnessScript(state, script),
    invocations: ofRole,
    invocation(role, n) {
      const found = ofRole(role)[n];
      if (!found) throw new Error(`the ${role} was never started a ${n + 1}th time`);
      return found;
    },
    async reached(signal) {
      await waitFor(`the worker to signal ${signal}`, () => existsSync(signalPath(state, signal)));
      return Number(readFileSync(signalPath(state, signal), "utf8"));
    },
    release(name) {
      mkdirSync(dirname(releasePath(state, name)), { recursive: true });
      writeFileSync(releasePath(state, name), "");
    },
    git: inRepo,
    onMain: (path) => inRepo(["ls-tree", "--name-only", "main", path]) === path,
    commitsOn: (branch) =>
      inRepo(["log", "--reverse", "--format=%s", `main..${branch}`])
        .split("\n")
        .filter(Boolean),
    ownerCommits,
    userSettings: (settings) => writeUser({ ...user, settings }),
    projectSettings(settings) {
      ownerCommits(".dim/config.json", `${JSON.stringify(settings)}\n`);
    },
    models: (models) => writeUser({ ...user, models }),
    createOperator,
    close() {
      for (const session of operators) session.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function machines(): (options?: MachineOptions) => Promise<Machine> {
  setDefaultTimeout(MACHINE_TEST_LIMIT_MS);
  const started: Machine[] = [];
  afterAll(() => {
    for (const machine of started.splice(0)) machine.close();
  });
  return async (options = {}) => {
    const machine = await createMachine(options);
    started.push(machine);
    return machine;
  };
}

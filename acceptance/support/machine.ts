import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OperatorSession } from "./operator-session";
import {
  type HarnessScript,
  type Invocation,
  invocations,
  releasePath,
  signalPath,
  writeHarnessScript,
} from "./scripted-harness-state";

const CHECKOUT = join(import.meta.dir, "..", "..");

export const MODELS = { standard: "scripted-standard", deep: "scripted-deep" } as const;

export type Machine = {
  root: string;
  env: Record<string, string>;
  repo: string;
  state: string;
  operator: OperatorSession;
  script(script: HarnessScript): void;
  invocations(): Invocation[];
  reached(signal: string): Promise<number>;
  release(name: string): void;
  git(args: string[], cwd?: string): string;
  newOperator(): Promise<OperatorSession>;
  close(): void;
};

export type MachineOptions = {
  project?: string;
  check?: string | ((root: string) => string);
  ownerEnv?: Record<string, string>;
};

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export function git(args: string[], cwd: string): string {
  const ran = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.toString()}`);
  return ran.stdout.toString().trim();
}

function initRepo(repo: string, project: string, check: string): void {
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Owner"], repo);
  git(["config", "user.email", "owner@example.com"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  git(["remote", "add", "origin", `git@github.com:${project}.git`], repo);
  mkdirSync(join(repo, ".dim"));
  writeFileSync(join(repo, ".dim", "config.json"), `${JSON.stringify({ ship: "trunk" })}\n`);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { verify: check } })}\n`);
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  writeFileSync(join(repo, "README.md"), "# widgets\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "chore: start"], repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo);
}

export async function newMachine(options: MachineOptions = {}): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), "dim-acceptance-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(root, "harness");
  const repo = join(root, "repo");
  for (const dir of [bin, home, state, join(root, "dim")]) mkdirSync(dir, { recursive: true });

  executable(join(bin, "dim"), `#!/bin/sh\nexec bun "${join(CHECKOUT, "src", "cli.ts")}" "$@"\n`);
  executable(
    join(bin, "claude"),
    `#!/bin/sh\nexec bun "${join(import.meta.dir, "scripted-claude.ts")}" "${state}" "$@"\n`,
  );

  const env: Record<string, string> = {
    ...options.ownerEnv,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    DIM_HOME: join(root, "dim"),
    DIM_CLAUDE_PROJECTS: join(home, ".claude", "projects"),
    DIM_CODEX_DIR: join(home, ".codex"),
    GROK_HOME: join(home, ".grok"),
  };
  writeFileSync(join(env.DIM_HOME as string, "routing.json"), JSON.stringify({ claude: MODELS }));
  const check = typeof options.check === "function" ? options.check(root) : (options.check ?? "true");
  initRepo(repo, options.project ?? "acme/widgets", check);

  const operators: OperatorSession[] = [];
  const newOperator = async () => {
    const session = await OperatorSession.open(env, repo);
    operators.push(session);
    return session;
  };
  const setup = await newOperator();
  await setup.dimOk(["hooks", "install"]);
  await setup.register();

  return {
    root,
    env,
    repo,
    state,
    operator: setup,
    script: (script) => writeHarnessScript(state, script),
    invocations: () => invocations(state),
    async reached(signal) {
      while (!existsSync(signalPath(state, signal))) await Bun.sleep(20);
      return Number(readFileSync(signalPath(state, signal), "utf8"));
    },
    release(name) {
      mkdirSync(dirname(releasePath(state, name)), { recursive: true });
      writeFileSync(releasePath(state, name), "");
    },
    git: (args, cwd = repo) => git(args, cwd),
    newOperator,
    close() {
      for (const session of operators) session.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

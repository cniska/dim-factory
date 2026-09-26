import { relative, resolve } from "node:path";
import { checkoutRoot } from "./checkout";
import { type Command, Ran, UsageError } from "./command";
import { purgeCheckout } from "./comments-purge";
import { stagedComments } from "./comments-staged";
import { COMMENTS_FOUND_EXIT, commentsBanned } from "./commit-gate";
import { PROJECT_CONFIG, projectConfigPath, readProjectConfig, writeConfigValue } from "./config";
import { warn } from "./warn";
import { checkTask, formatTask } from "./workspace-tasks";

const USAGE = "usage: dim comments check | dim comments purge [--write] [<path>...]";

function check(cwd: string): void {
  const root = checkoutRoot(cwd);
  if (root === null || !commentsBanned(root, "HEAD")) return;
  const { found, unparsed } = stagedComments(root);
  for (const path of unparsed) warn(`dim: ${path} does not parse, so its comments are not judged`);
  for (const { path, line } of found) console.log(`${path}:${line}`);
  if (found.length > 0) process.exit(COMMENTS_FOUND_EXIT);
}

type Formatted = { command: string; exitCode: number | null; signal: string | null; output: string };

function formatted(root: string, command: string): Formatted {
  const run = Bun.spawnSync(["sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const failed = run.exitCode !== 0;
  return {
    command,
    exitCode: run.exitCode,
    signal: run.signalCode ?? null,
    output: failed ? `${run.stdout.toString()}${run.stderr.toString()}`.trim() : "",
  };
}

function purge(cwd: string, args: string[]): unknown {
  const root = checkoutRoot(cwd);
  if (root === null) throw new Error(`${cwd} is not inside a git checkout`);
  const write = args.includes("--write");
  const paths = args
    .filter((arg) => arg !== "--write")
    .map((path) => relative(root, resolve(cwd, path)) || ".");
  readProjectConfig(root);
  if (write) writeConfigValue(projectConfigPath(root), "comments", "banned");
  const { files, unparsed } = purgeCheckout(root, { write, paths });
  const comments = files.reduce((sum, file) => sum + file.removed, 0);
  const ban = PROJECT_CONFIG;
  const format = formatTask(root)?.commandLine ?? null;
  const check = checkTask(root)?.commandLine ?? null;
  if (!write) {
    const steps = [`removes them`, `bans comments in ${ban}`, format ? `runs ${format}` : null];
    return {
      files,
      unparsed,
      comments,
      next: `dim comments purge --write ${steps.filter(Boolean).join(", ")}`,
    };
  }
  const ran = format ? formatted(root, format) : null;
  const failed = ran !== null && ran.exitCode !== 0;
  const report = {
    files,
    unparsed,
    comments,
    banned: ban,
    format: ran,
    next: failed
      ? `${ran.command} failed; fix it before committing`
      : `${check ? `run ${check}, then ` : ""}commit the purge together with ${ban}`,
  };
  return failed ? new Ran(report, 1) : report;
}

export const commentsCommand: Command = {
  name: "comments",
  usage: USAGE,
  summary: "check staged lines for comments the config bans, or purge the comments a repo holds",
  raw: (args) => args[0] === "check",
  run(args) {
    const [verb, ...rest] = args;
    if (verb === "check") return check(process.cwd());
    if (verb === "purge") return purge(process.cwd(), rest);
    throw new UsageError(
      verb === undefined ? "comments takes check or purge" : `${verb} is not a comments verb`,
    );
  },
};

import { relative, resolve } from "node:path";
import { type Command, Ran, UsageError } from "./cli-contract";
import { purgeCheckout } from "./comments-purge";
import { PROJECT_CONFIG, projectConfigPath, readProjectConfig, writeConfigValue } from "./config";
import { checkTask, formatTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";

const USAGE = "usage: dim comments purge [--write] [<path>...]";

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
  if (root === null) throw new UsageError(`${cwd} is not inside a git checkout`);
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
  summary: "purge the comments a repo holds and ban new ones",
  run(args) {
    const [verb, ...rest] = args;
    if (verb === "purge") return purge(process.cwd(), rest);
    throw new UsageError(verb === undefined ? "comments takes purge" : `${verb} is not a comments verb`);
  },
};

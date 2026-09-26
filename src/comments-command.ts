import { relative, resolve } from "node:path";
import { checkoutRoot } from "./checkout";
import { purgeCheckout } from "./comments-purge";
import { stagedComments } from "./comments-staged";
import { COMMENTS_FOUND_EXIT, commentsBanned } from "./commit-gate";
import { PROJECT_CONFIG, projectConfigPath, readProjectConfig, writeConfigValue } from "./config";
import { warn } from "./warn";
import { checkCommand, formatCommand } from "./workspace-commands";

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

function purge(cwd: string, args: string[]): void {
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
  const format = formatCommand(root)?.command ?? null;
  const check = checkCommand(root)?.command ?? null;
  if (!write) {
    const steps = [`removes them`, `bans comments in ${ban}`, format ? `runs ${format}` : null];
    console.log(
      JSON.stringify({
        files,
        unparsed,
        comments,
        next: `dim comments purge --write ${steps.filter(Boolean).join(", ")}`,
      }),
    );
    return;
  }
  const ran = format ? formatted(root, format) : null;
  console.log(
    JSON.stringify({
      files,
      unparsed,
      comments,
      banned: ban,
      format: ran,
      next:
        ran && ran.exitCode !== 0
          ? `${ran.command} failed; fix it before committing`
          : `${check ? `run ${check}, then ` : ""}commit the purge together with ${ban}`,
    }),
  );
  if (ran && ran.exitCode !== 0) process.exit(1);
}

export function runComments(args: string[], cwd = process.cwd()): void {
  const [verb, ...rest] = args;
  if (verb === "check") check(cwd);
  else if (verb === "purge") purge(cwd, rest);
  else {
    warn(USAGE);
    process.exit(1);
  }
}

import { relative, resolve } from "node:path";
import { checkoutRoot } from "./checkout";
import { commentsBanned } from "./comments-ban-setting";
import { purgeCheckout } from "./comments-purge";
import { stagedComments } from "./comments-staged";
import { COMMENTS_FOUND_EXIT } from "./commit-gate";
import { labelFor } from "./git-remote";
import { warn } from "./warn";
import { formatCommand } from "./workspace-commands";

const USAGE = "usage: dim comments check | dim comments purge [--write] [<path>...]";

function check(cwd: string): void {
  const root = checkoutRoot(cwd);
  const label = root === null ? null : labelFor(root);
  if (root === null || label === null || !commentsBanned(label)) return;
  const { found, unparsed } = stagedComments(root);
  for (const path of unparsed) warn(`dim: ${path} does not parse, so its comments are not judged`);
  for (const { path, line } of found) console.log(`${path}:${line}`);
  if (found.length > 0) process.exit(COMMENTS_FOUND_EXIT);
}

function purge(cwd: string, args: string[]): void {
  const root = checkoutRoot(cwd);
  if (root === null) throw new Error(`${cwd} is not inside a git checkout`);
  const write = args.includes("--write");
  const given = args.filter((arg) => arg !== "--write");
  const paths = given.map((path) => relative(root, resolve(cwd, path)) || ".");
  const { files, unparsed } = purgeCheckout(root, { write, paths });
  for (const { path, removed } of files) console.log(`${path}: ${removed}`);
  for (const path of unparsed) warn(`dim: ${path} does not parse, so it is left as it is`);
  const total = files.reduce((sum, file) => sum + file.removed, 0);
  if (total === 0) {
    console.log("no comments to purge in the tracked files of a language dim reads");
    return;
  }
  const where = `${files.length} file${files.length === 1 ? "" : "s"}`;
  if (!write) {
    console.log(`${total} comments in ${where} would go. Re-run with --write to purge them.`);
    return;
  }
  const format = formatCommand(root);
  console.log(
    `purged ${total} comments from ${where}; ` +
      (format ? `run ${format.command} to tidy the lines they left` : "run this repo's formatter next"),
  );
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

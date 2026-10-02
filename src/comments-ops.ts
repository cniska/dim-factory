import { relative, resolve } from "node:path";
import { refuseComments } from "./comments-contract";
import { type PurgedFile, purgeCheckout } from "./comments-purge";
import { checkTask, formatTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";

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

type Counted = { files: PurgedFile[]; unparsed: string[]; comments: number };

export type Purged =
  | { readonly written: false; readonly report: Counted & { next: string } }
  | {
      readonly written: true;
      readonly failed: boolean;
      readonly report: Counted & { format: Formatted | null; next: string };
    };

export function purgeComments(
  cwd: string,
  options: { readonly write: boolean; readonly paths: readonly string[] },
): Purged {
  const root = checkoutRoot(cwd);
  if (root === null) throw refuseComments("not_a_checkout", { cwd });
  const paths = options.paths.map((path) => relative(root, resolve(cwd, path)) || ".");
  const { files, unparsed } = purgeCheckout(root, { write: options.write, paths });
  const comments = files.reduce((sum, file) => sum + file.removed, 0);
  const format = formatTask(root)?.commandLine ?? null;
  const check = checkTask(root)?.commandLine ?? null;
  if (!options.write) {
    const steps = ["removes them", format ? `runs ${format}` : null];
    return {
      written: false,
      report: {
        files,
        unparsed,
        comments,
        next: `dim comments purge --write ${steps.filter(Boolean).join(", ")}`,
      },
    };
  }
  const ran = format ? formatted(root, format) : null;
  const failed = ran !== null && ran.exitCode !== 0;
  return {
    written: true,
    failed,
    report: {
      files,
      unparsed,
      comments,
      format: ran,
      next: failed
        ? `${ran.command} failed; fix it before committing`
        : `${check ? `run ${check}, then ` : ""}commit the purge`,
    },
  };
}

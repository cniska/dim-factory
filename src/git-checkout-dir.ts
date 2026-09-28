import { join } from "node:path";

function revParse(cwd: string, ...args: string[]): string | null {
  const run = Bun.spawnSync(["git", "-C", cwd, "rev-parse", ...args], { stdout: "pipe", stderr: "ignore" });
  if (run.exitCode !== 0) return null;
  return run.stdout.toString().trim() || null;
}

export function checkoutGitPaths(cwd: string): string[] {
  const top = revParse(cwd, "--show-toplevel");
  if (!top) return [];
  const common = revParse(cwd, "--path-format=absolute", "--git-common-dir");
  const paths = [join(top, ".git")];
  if (common && !paths.includes(common)) paths.push(common);
  return paths;
}

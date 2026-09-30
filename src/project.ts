import { checkoutRoot } from "./git-checkout";
import { originLabel } from "./git-remote";

export type Checkout = { readonly root: string; readonly project: string };

export function checkoutAt(dir: string): Checkout | null {
  const root = checkoutRoot(dir);
  if (root === null) return null;
  const project = originLabel(root);
  return project === null ? null : { root, project };
}

export function defaultBranch(root: string): string | null {
  const ran = Bun.spawnSync(["git", "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const head = ran.exitCode === 0 ? ran.stdout.toString().trim() : "";
  return head.startsWith("origin/") ? head.slice("origin/".length) : null;
}

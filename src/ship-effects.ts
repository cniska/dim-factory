import { join } from "node:path";
import { invariant } from "./assert";
import { tryClaimPathLock } from "./db-lock";
import { git, ran } from "./git-tree";
import { type Env, locksDir } from "./paths";

const LOCK_POLL_MS = 100;

export async function shipLock(project: string, env: Env): Promise<() => void> {
  const path = join(locksDir(env), `ship-${project.replace("/", "-")}`);
  for (;;) {
    const release = tryClaimPathLock(path);
    if (release !== null) return release;
    await Bun.sleep(LOCK_POLL_MS);
  }
}

export function commitsSince(root: string, defaultBranch: string, head: string): readonly string[] {
  const listed = ran(root, ["rev-list", "--reverse", `refs/heads/${defaultBranch}..${head}`]);
  return listed === "" ? [] : listed.split("\n");
}

export type Merged =
  | { readonly kind: "clean"; readonly tree: string }
  | { readonly kind: "conflict"; readonly tree: string; readonly paths: readonly string[] };

export function mergeTree(root: string, base: string, ours: string, theirs: string): Merged {
  const merged = git(root, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    `--merge-base=${base}`,
    ours,
    theirs,
  ]);
  const [tree = "", ...paths] = merged.out.split("\n").filter((line) => line !== "");
  if (merged.ok) return { kind: "clean", tree };
  invariant(
    paths.length > 0 && tree !== "",
    `git merge-tree of ${theirs} onto ${ours} in ${root}: ${merged.err}`,
  );
  return { kind: "conflict", tree, paths };
}

const FACTORY_COMMITTER = { GIT_COMMITTER_NAME: "dim", GIT_COMMITTER_EMAIL: "factory@dim.local" };

export function recommit(root: string, commit: string, tree: string, parent: string, env: Env): string {
  const [name = "", email = "", date = "", ...message] = ran(root, [
    "log",
    "-1",
    "--format=%an%n%ae%n%aI%n%B",
    commit,
  ]).split("\n");
  return ran(root, ["commit-tree", tree, "-p", parent, "-m", message.join("\n").trim()], {
    ...env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    ...FACTORY_COMMITTER,
  });
}

export function parentOf(root: string, commit: string): string {
  return ran(root, ["rev-parse", `${commit}^`]);
}

export function checkedOutBranch(root: string): string | null {
  const head = git(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return head.ok ? head.out : null;
}

export function fastForward(root: string, head: string): boolean {
  return git(root, ["merge", "-q", "--ff-only", head]).ok;
}

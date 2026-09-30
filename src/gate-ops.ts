import { existsSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { type GatePlan, installCommitGate, sharedHooksDir } from "./gate-install";
import { checkoutSlug } from "./git-remote";
import { isHostQualified } from "./git-remote-slug";
import { recordedRepos } from "./ingest-git";
import { dbPath, type Env, resolveHomeDir } from "./paths";

type RecordedCheckout = { readonly repo: string; readonly owner: string | null };

function recordedCheckouts(env: Env): readonly RecordedCheckout[] {
  const db = openReadOnly(dbPath(env));
  try {
    return recordedRepos(db).map((repo) => ({ repo, owner: checkoutSlug(repo) }));
  } finally {
    db.close();
  }
}

function checkoutDirs(repos: readonly string[], env: Env): string[] {
  const code = join(resolveHomeDir(env), "code");
  return repos.filter((repo) => repo.startsWith(code) && existsSync(join(repo, ".git")));
}

export type InstalledGate = GatePlan & { readonly owners: readonly string[]; readonly hooksDir: string };

export function installGate(owners: readonly string[], env: Env = process.env): InstalledGate {
  const bare = owners.filter((owner) => !isHostQualified(owner));
  if (bare.length > 0) {
    throw new UsageError(
      `${bare.join(", ")} names an account but no host, so the gate would arm nowhere; an owner is the whole of a remote URL before the repository, as in github.com/<account>`,
    );
  }
  const seen = recordedCheckouts(env);
  if (owners.length === 0) {
    const counts = new Map<string, number>();
    for (const { owner } of seen) if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    throw new UsageError(
      `name the owners whose commits to gate with --owner <host>/<account>, so a clone of someone else's project keeps its own rules; the record has ${[...counts].map(([owner, n]) => `${owner} (${n} checkouts)`).join(", ") || "no checkouts"}`,
    );
  }
  const stranded = checkoutDirs(
    seen.map(({ repo }) => repo),
    env,
  );
  return { ...installCommitGate(owners, stranded, env), owners, hooksDir: sharedHooksDir(env) };
}

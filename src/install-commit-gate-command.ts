import { type Command, Ran, UsageError } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { checkoutDirs, installCommitGate, planCommitGate, sharedHooksDir } from "./gate-commit";
import { checkoutSlug } from "./git-remote";
import { isHostQualified } from "./git-remote-slug";
import { WRITE_NEXT } from "./install-write";
import { dbPath } from "./paths";

function checkouts(): { repo: string; owner: string }[] {
  const db = openReadOnly(dbPath());
  try {
    return db
      .query<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit ORDER BY repo")
      .all()
      .map((row) => ({ repo: row.repo, owner: checkoutSlug(row.repo) ?? "" }));
  } finally {
    db.close();
  }
}

export const installCommitGateCommand: Command = {
  name: "install-commit-gate",
  usage: "usage: dim install-commit-gate --owner=<host>/<account> [--owner=...] [--write]",
  summary:
    "show the commit gate one hooks directory would install for the owners named (--write installs it)",
  run(args) {
    const owners = args.filter((a) => a.startsWith("--owner=")).map((a) => a.slice("--owner=".length));
    const bare = owners.filter((owner) => !isHostQualified(owner));
    if (bare.length > 0) {
      throw new UsageError(
        `${bare.join(", ")} names an account but no host, so the gate would arm nowhere; an owner is the whole of a remote URL before the repository, as in github.com/<account>`,
      );
    }
    const seen = checkouts();
    if (owners.length === 0) {
      const counts = new Map<string, number>();
      for (const { owner } of seen) if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      throw new UsageError(
        `name the owners whose commits to gate with --owner=<host>/<account>, so a clone of someone else's project keeps its own rules; the record has ${[...counts].map(([owner, n]) => `${owner} (${n} checkouts)`).join(", ") || "no checkouts"}`,
      );
    }
    const stranded = checkoutDirs(seen);
    const plan = { ...planCommitGate(owners, stranded), owners, hooksDir: sharedHooksDir() };
    if (plan.globalHooksPath !== null && plan.globalHooksPath !== sharedHooksDir()) {
      return new Ran(
        {
          ...plan,
          refused: `${plan.globalHooksPath} already holds the one hooks directory git reads; point it at ${sharedHooksDir()}, or git config --global --unset core.hooksPath`,
        },
        1,
      );
    }
    if (!args.includes("--write")) return { ...plan, next: WRITE_NEXT };
    return { ...installCommitGate(owners, stranded), owners, hooksDir: sharedHooksDir(), written: true };
  },
};

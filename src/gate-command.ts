import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, Ran, UsageError } from "./cli-contract";
import { warn } from "./cli-warn";
import { openReadOnly } from "./db-read";
import { judge } from "./gate";
import { checkRange } from "./gate-check-commits";
import { GATE_HOOKS, REFUSED_EXIT } from "./gate-contract";
import { installCommitGate, sharedHooksDir } from "./gate-install";
import { checkoutSlug } from "./git-remote";
import { isHostQualified } from "./git-remote-slug";
import { dbPath, resolveHomeDir } from "./paths";

const USAGE = `usage: dim gate install --owner <host>/<account> [--owner ...] | dim gate check <range> | dim gate <installed hook: ${GATE_HOOKS.join(" | ")}> [<arguments git passes it>...]`;

function checkoutDirs(repos: readonly string[]): string[] {
  const code = join(resolveHomeDir(process.env), "code");
  return repos.filter((repo) => repo.startsWith(code) && existsSync(join(repo, ".git")));
}

function checkouts(): { readonly repo: string; readonly owner: string | null }[] {
  const db = openReadOnly(dbPath());
  try {
    return db
      .query<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit ORDER BY repo")
      .all()
      .map((row) => ({ repo: row.repo, owner: checkoutSlug(row.repo) }));
  } finally {
    db.close();
  }
}

function ownersOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg !== "--owner") return [];
    const owner = args[index + 1];
    if (owner === undefined)
      throw new UsageError("--owner needs a value, as in --owner github.com/<account>");
    return [owner];
  });
}

function install(args: readonly string[]) {
  const owners = ownersOf(args);
  const bare = owners.filter((owner) => !isHostQualified(owner));
  if (bare.length > 0) {
    throw new UsageError(
      `${bare.join(", ")} names an account but no host, so the gate would arm nowhere; an owner is the whole of a remote URL before the repository, as in github.com/<account>`,
    );
  }
  const seen = checkouts();
  if (owners.length === 0) {
    const counts = new Map<string, number>();
    for (const { owner } of seen) if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    throw new UsageError(
      `name the owners whose commits to gate with --owner <host>/<account>, so a clone of someone else's project keeps its own rules; the record has ${[...counts].map(([owner, n]) => `${owner} (${n} checkouts)`).join(", ") || "no checkouts"}`,
    );
  }
  const stranded = checkoutDirs(seen.map(({ repo }) => repo));
  return {
    ...installCommitGate(owners, stranded, process.env),
    owners,
    hooksDir: sharedHooksDir(process.env),
  };
}

function check(args: readonly string[]) {
  const [range] = args;
  if (!range) throw new UsageError("gate check needs a revision range, e.g. main..HEAD");
  const offenses = checkRange(range, process.cwd());
  return new Ran({ range, offenses }, offenses.length === 0 ? 0 : 1);
}

function judgeHook(hook: string | undefined, rest: string[]): void {
  if (hook === undefined) throw new UsageError(USAGE);
  const refusal = judge(hook, {
    args: rest,
    cwd: process.cwd(),
    env: process.env,
    stdin: () => readFileSync(0, "utf8"),
    say: warn,
  });
  if (refusal === null) throw new UsageError(USAGE);
  for (const line of refusal) warn(line);
  if (refusal.length > 0) process.exitCode = REFUSED_EXIT;
}

export const gateCommand: Command = {
  name: "gate",
  usage: USAGE,
  summary:
    "install the commit gate for the owners named, judge a range's subjects, or judge a commit or push for the git hook that calls it",
  raw: (args) => args[0] !== "install" && args[0] !== "check",
  run(args) {
    const [verb, ...rest] = args;
    if (verb === "install") return install(rest);
    if (verb === "check") return check(rest);
    return judgeHook(verb, rest);
  },
};

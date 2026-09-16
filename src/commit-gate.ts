import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

/**
 * The rule is `cniska/apps`' own, which is the only repo on this machine whose
 * subjects never break it: a mechanical gate holds it at zero while the same
 * rule written down elsewhere drifts. Inclusive at 50 because that is what the
 * conforming history holds — its longest subject sits exactly on the limit.
 */
export const SUBJECT_LIMIT = 50;

const TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf", "build", "ci", "revert"];

export type Violation = "empty" | "body" | "not-conventional" | "too-long" | "not-ascii";

/** Every rule the gate enforces, in the order the hook reports them. */
export function checkSubject(subject: string, body = ""): Violation | null {
  if (subject.trim() === "") return "empty";
  if (body.trim() !== "") return "body";
  if (!new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: .+`).test(subject)) return "not-conventional";
  if (subject.length > SUBJECT_LIMIT) return "too-long";
  if (/[^\x20-\x7e]/.test(subject)) return "not-ascii";
  return null;
}

/**
 * Self-contained bash: the hook must not need `dim`, `bun` or anything else on
 * a PATH git did not promise it. A gate that cannot run is a gate that passes.
 */
export function hookScript(): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. Subject rules, held mechanically.
set -euo pipefail

msg_file="$1"
subject=$(sed -n '1p' "$msg_file")
body=$(sed -n '2,$p' "$msg_file" | grep -v '^#' | sed '/^[[:space:]]*$/d' || true)

types='${TYPES.join("|")}'
fail() { echo "commit-msg: $1" >&2; echo "  got: $subject" >&2; exit 1; }

[ -n "$subject" ] || fail "subject is empty."
[ -z "$body" ] || fail "commit has a body. The subject is the whole message."
[[ "$subject" =~ ^($types)(\\([a-z0-9-]+\\))?!?:\\ .+ ]] || fail "subject is not a Conventional Commit (type(scope): what changed)."
[ "\${#subject}" -le ${SUBJECT_LIMIT} ] || fail "subject is \${#subject} characters, over the ${SUBJECT_LIMIT} allowed."
printf '%s' "$subject" | LC_ALL=C grep -q '[^ -~]' && fail "subject is not ASCII."

exit 0
`;
}

export type GatePlan = {
  repo: string;
  path: string;
  state: "installed" | "missing" | "occupied" | "has-own-gate";
};

/** A repo whose own hooks already check subjects is left alone rather than double-gated. */
function hasOwnGate(repo: string): boolean {
  for (const candidate of ["scripts/check-commit-message.sh", ".githooks/commit-msg"]) {
    if (existsSync(join(repo, candidate))) return true;
  }
  return false;
}

export function planCommitGate(repos: string[]): GatePlan[] {
  return repos.map((repo) => {
    const path = join(repo, ".git", "hooks", "commit-msg");
    if (hasOwnGate(repo)) return { repo, path, state: "has-own-gate" as const };
    if (!existsSync(path)) return { repo, path, state: "missing" as const };
    const current = readFileSync(path, "utf8");
    if (current === hookScript()) return { repo, path, state: "installed" as const };
    return { repo, path, state: "occupied" as const };
  });
}

export function installCommitGate(repos: string[]): GatePlan[] {
  const plans = planCommitGate(repos);
  for (const plan of plans) {
    if (plan.state === "installed" || plan.state === "has-own-gate") continue;
    mkdirSync(dirname(plan.path), { recursive: true });
    // Whatever is there may be the only copy of a hook written by hand.
    if (plan.state === "occupied") copyFileSync(plan.path, `${plan.path}.dim-backup`);
    writeFileSync(plan.path, hookScript());
    chmodSync(plan.path, 0o755);
  }
  return plans;
}

export type Checkout = { repo: string; owner: string };

/**
 * The checkouts the corpus has seen commits from, narrowed to the owners named.
 * Ownership is not inferred: a clone of someone else's project has its own
 * conventions, and gating it would refuse contributions that are correct there.
 */
export function repoDirs(checkouts: Checkout[], owners: string[], env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  return checkouts
    .filter((c) => owners.includes(c.owner))
    .map((c) => c.repo)
    .filter((r) => r.startsWith(join(home, "code")) && existsSync(join(r, ".git")));
}

export function ownerOf(label: string | null): string {
  return label?.includes("/") ? (label.split("/")[0] as string) : "";
}

export function gitToplevel(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

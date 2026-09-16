import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

/**
 * The rule is `cniska/apps`' own, the one repo whose subjects never break it: a
 * mechanical gate holds it at zero while the same rule written down drifts.
 * Inclusive at 50 because that is what the conforming history holds.
 */
export const SUBJECT_LIMIT = 50;

const TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf", "build", "ci", "revert"];

export type Violation = "empty" | "body" | "not-conventional" | "too-long" | "not-ascii";

export function checkSubject(subject: string, body = ""): Violation | null {
  if (subject.trim() === "") return "empty";
  if (body.trim() !== "") return "body";
  if (!new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: .+`).test(subject)) return "not-conventional";
  if (subject.length > SUBJECT_LIMIT) return "too-long";
  if (/[^\x20-\x7e]/.test(subject)) return "not-ascii";
  return null;
}

/**
 * One directory for every repo rather than a copy per checkout. Git resolves
 * `core.hooksPath` locally before globally, so a repo carrying its own hooks
 * keeps them and everything else picks this up — including a repo cloned after
 * this was installed, which is what a per-checkout copy could never cover.
 */
export function sharedHooksDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".config", "dim", "hooks");
}

/**
 * Ownership is checked when the hook runs, not when it is installed: a clone of
 * someone else's project has its own conventions, and one set globally would
 * otherwise refuse contributions that are correct there. Anything unexpected —
 * no remote, no git, an unreadable message — exits 0. This runs before every
 * commit on the machine, so it may only ever fail on a subject it has read.
 */
export function hookScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

msg_file="\${1:-}"
[ -n "$msg_file" ] && [ -r "$msg_file" ] || exit 0

origin=$(git config --get remote.origin.url 2>/dev/null || true)
owner=$(printf '%s' "$origin" | sed -n 's#.*[:/]\\([^/]*\\)/[^/]*$#\\1#p')
case " ${owners.join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

subject=$(sed -n '1p' "$msg_file" 2>/dev/null || true)
body=$(sed -n '2,$p' "$msg_file" 2>/dev/null | grep -v '^#' | sed '/^[[:space:]]*$/d' || true)

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
  hookPath: string;
  state: "installed" | "missing" | "stale";
  globalHooksPath: string | null;
  strandedCopies: string[];
};

function gitGlobal(key: string): string | null {
  try {
    return execFileSync("git", ["config", "--global", "--get", key], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function planCommitGate(
  owners: string[],
  strandedIn: string[] = [],
  env: Env = process.env,
): GatePlan {
  const hookPath = join(sharedHooksDir(env), "commit-msg");
  const want = hookScript(owners);
  const state = !existsSync(hookPath)
    ? ("missing" as const)
    : readFileSync(hookPath, "utf8") === want
      ? ("installed" as const)
      : ("stale" as const);
  return {
    hookPath,
    state,
    globalHooksPath: gitGlobal("core.hooksPath"),
    strandedCopies: strandedIn
      .map((r) => join(r, ".git", "hooks", "commit-msg"))
      .filter((p) => existsSync(p)),
  };
}

/** Writes the one hook, points git at it, and clears the per-checkout copies it replaces. */
export function installCommitGate(
  owners: string[],
  strandedIn: string[] = [],
  env: Env = process.env,
): GatePlan {
  const dir = sharedHooksDir(env);
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, "commit-msg");
  writeFileSync(hookPath, hookScript(owners));
  chmodSync(hookPath, 0o755);
  const plan = planCommitGate(owners, strandedIn, env);
  for (const copy of plan.strandedCopies) rmSync(copy, { force: true });
  execFileSync("git", ["config", "--global", "core.hooksPath", dir]);
  return { ...plan, state: "installed", globalHooksPath: dir, strandedCopies: plan.strandedCopies };
}

export function ownerOf(label: string | null): string {
  return label?.includes("/") ? (label.split("/")[0] as string) : "";
}

export type Checkout = { repo: string; owner: string };

/** Checkouts that carry a per-repo copy this replaces. */
export function checkoutDirs(checkouts: Checkout[], env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  return checkouts
    .map((c) => c.repo)
    .filter((r) => r.startsWith(join(home, "code")) && existsSync(join(r, ".git")));
}

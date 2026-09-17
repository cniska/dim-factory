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

/** `--no-verify` is git's only escape and it takes the subject gate with it; this skips one hook. */
export const SKIP_CHECK_ENV = "DIM_SKIP_CHECK";

/**
 * Refuses a commit whose repo declares a check that fails. Anything it cannot
 * establish exits 0, as the commit-msg hook does. The ownership check guards an
 * `eval` of the repo's own manifest: a clone of someone else's project must
 * never have its scripts run by a hook installed globally here.
 */
export function preCommitScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

[ "\${${SKIP_CHECK_ENV}:-}" = "1" ] && exit 0

origin=$(git config --get remote.origin.url 2>/dev/null || true)
owner=$(printf '%s' "$origin" | sed -n 's#.*[:/]\\([^/]*\\)/[^/]*$#\\1#p')
case " ${owners.join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

command -v dim >/dev/null 2>&1 || exit 0
task=$(dim check-task 2>/dev/null || true)
[ -n "$task" ] || exit 0

echo "pre-commit: $task" >&2
if ! eval "$task" >&2; then
  echo "pre-commit: the repo's own check failed, so the commit is refused." >&2
  echo "  fix it, or ${SKIP_CHECK_ENV}=1 git commit to commit without it." >&2
  exit 1
fi
exit 0
`;
}

export type GatePlan = {
  hookPath: string;
  state: "installed" | "missing" | "stale";
  checkHookPath: string;
  checkState: "installed" | "missing" | "stale";
  globalHooksPath: string | null;
  strandedCopies: string[];
};

/** Env is threaded in so a test can point GIT_CONFIG_GLOBAL at a scratch file rather than the reader's own. */
function gitEnv(env: Env): NodeJS.ProcessEnv {
  return { ...process.env, ...env } as NodeJS.ProcessEnv;
}

function gitGlobal(key: string, env: Env): string | null {
  try {
    return (
      execFileSync("git", ["config", "--global", "--get", key], {
        encoding: "utf8",
        env: gitEnv(env),
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function planCommitGate(
  owners: string[],
  strandedIn: string[] = [],
  env: Env = process.env,
): GatePlan {
  const dir = sharedHooksDir(env);
  const stateOf = (path: string, want: string) =>
    !existsSync(path)
      ? ("missing" as const)
      : readFileSync(path, "utf8") === want
        ? ("installed" as const)
        : ("stale" as const);
  const hookPath = join(dir, "commit-msg");
  const checkHookPath = join(dir, "pre-commit");
  return {
    hookPath,
    state: stateOf(hookPath, hookScript(owners)),
    checkHookPath,
    checkState: stateOf(checkHookPath, preCommitScript(owners)),
    globalHooksPath: gitGlobal("core.hooksPath", env),
    strandedCopies: strandedIn
      .map((r) => join(r, ".git", "hooks", "commit-msg"))
      .filter((p) => existsSync(p)),
  };
}

export class HooksPathTakenError extends Error {
  readonly code = "HOOKS_PATH_TAKEN";
  constructor(readonly existing: string) {
    super(
      `git's global core.hooksPath is already ${existing}; ` +
        "git honors one hooks directory and there is no merge, so installing here would disable it. " +
        "Point that directory at this hook, or unset it with `git config --global --unset core.hooksPath`.",
    );
  }
}

/**
 * Writes the one hook, points git at it, and clears the per-checkout copies it replaces.
 *
 * The refusal comes before every write: a machine that already routes its hooks
 * somewhere loses them the moment this sets the one setting git reads, and the
 * per-repo copies deleted on the way would leave it gated by nothing at all.
 */
export function installCommitGate(
  owners: string[],
  strandedIn: string[] = [],
  env: Env = process.env,
): GatePlan {
  const dir = sharedHooksDir(env);
  const existing = gitGlobal("core.hooksPath", env);
  if (existing && existing !== dir) throw new HooksPathTakenError(existing);

  mkdirSync(dir, { recursive: true });
  for (const [name, body] of [
    ["commit-msg", hookScript(owners)],
    ["pre-commit", preCommitScript(owners)],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const plan = planCommitGate(owners, strandedIn, env);
  for (const copy of plan.strandedCopies) rmSync(copy, { force: true });
  execFileSync("git", ["config", "--global", "core.hooksPath", dir], { env: gitEnv(env) });
  return { ...plan, globalHooksPath: dir };
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

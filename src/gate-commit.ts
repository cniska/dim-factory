import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig } from "./config";
import { prePushScript } from "./gate-push";
import { checkoutSlug, labelFor } from "./git-remote";
import { foldAscii, SLUG_SED } from "./git-remote-slug";
import { type Env, resolveHomeDir } from "./paths";

export const SUBJECT_LIMIT = 50;

const TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf", "build", "ci"];

export type Violation = "empty" | "body" | "not-conventional" | "too-long" | "not-ascii";

export function checkSubject(subject: string, body = ""): Violation | null {
  if (subject.trim() === "") return "empty";
  if (body.trim() !== "") return "body";
  if (!new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: .+`).test(subject)) return "not-conventional";
  if (subject.length > SUBJECT_LIMIT) return "too-long";
  if (/[^\x20-\x7e]/.test(subject)) return "not-ascii";
  return null;
}

export function sharedHooksDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".config", "dim", "hooks");
}

export function hookScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

msg_file="\${1:-}"
[ -n "$msg_file" ] && [ -r "$msg_file" ] || exit 0

origin=$(git config --get remote.origin.url 2>/dev/null || true)
owner=$(printf '%s' "$origin" | sed -nE '${SLUG_SED}')
[ -n "$owner" ] || exit 0
case " ${owners.map(foldAscii).join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

merge_head=$(git rev-parse --git-path MERGE_HEAD 2>/dev/null || true)
[ -n "$merge_head" ] && [ -e "$merge_head" ] && exit 0

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

export const SKIP_CHECK_ENV = "DIM_SKIP_CHECK";

export const COMMENTS_FOUND_EXIT = 3;

export function preCommitScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

[ "\${${SKIP_CHECK_ENV}:-}" = "1" ] && exit 0

origin=$(git config --get remote.origin.url 2>/dev/null || true)
owner=$(printf '%s' "$origin" | sed -nE '${SLUG_SED}')
[ -n "$owner" ] || exit 0
case " ${owners.map(foldAscii).join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

command -v dim >/dev/null 2>&1 || exit 0

comments=$(dim comments check)
status=$?
if [ "$status" -eq ${COMMENTS_FOUND_EXIT} ]; then
  echo "pre-commit: this repo bans code comments, and these added lines carry one:" >&2
  printf '%s\\n' "$comments" | sed 's/^/  /' >&2
  echo "  put the why in a name, a test, or the doc that owns the subject." >&2
  echo "  or ${SKIP_CHECK_ENV}=1 git commit to commit without this hook." >&2
  exit 1
fi

check=$(dim check-command 2>/dev/null || true)
[ -n "$check" ] || exit 0

# Git exports these to a hook, and a check that runs git itself would inherit
# the committing repo's index, object store and author instead of its own.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE

echo "pre-commit: $check" >&2
if ! eval "$check" >&2; then
  echo "pre-commit: the repo's own check failed, so the commit is refused." >&2
  echo "  fix it, or ${SKIP_CHECK_ENV}=1 git commit to commit without it." >&2
  exit 1
fi
exit 0
`;
}

export function gateHooks(owners: string[]): { name: string; body: string }[] {
  return [
    { name: "commit-msg", body: hookScript(owners) },
    { name: "pre-commit", body: preCommitScript(owners) },
    { name: "pre-push", body: prePushScript(owners) },
  ];
}

export type GateHook = { name: string; path: string; state: "installed" | "missing" | "stale" };

export type GatePlan = {
  hooks: GateHook[];
  globalHooksPath: string | null;
  strandedCopies: string[];
};

function gitEnv(env: Env): NodeJS.ProcessEnv {
  return { ...process.env, ...env } as NodeJS.ProcessEnv;
}

const KEY_UNSET = 1;

export class GitConfigUnreadable extends Error {
  readonly code = "GIT_CONFIG_UNREADABLE";
}

function hooksPathOf(root: string, env: Env): string | null {
  const args = ["config", "--type=path", "--get", "core.hooksPath"];
  const read = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv(env) });
  if (read.status === KEY_UNSET) return null;
  if (read.status !== 0) {
    throw new GitConfigUnreadable(
      `git ${args.join(" ")} failed in ${root}: ${read.stderr?.trim() || read.error?.message}`,
    );
  }
  return read.stdout.trim() || null;
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
  return {
    hooks: gateHooks(owners).map(({ name, body }) => ({
      name,
      path: join(dir, name),
      state: stateOf(join(dir, name), body),
    })),
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

export function installCommitGate(
  owners: string[],
  strandedIn: string[] = [],
  env: Env = process.env,
): GatePlan {
  const dir = sharedHooksDir(env);
  const existing = gitGlobal("core.hooksPath", env);
  if (existing && existing !== dir) throw new HooksPathTakenError(existing);

  mkdirSync(dir, { recursive: true });
  for (const { name, body } of gateHooks(owners)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const plan = planCommitGate(owners, strandedIn, env);
  for (const copy of plan.strandedCopies) rmSync(copy, { force: true });
  execFileSync("git", ["config", "--global", "core.hooksPath", dir], { env: gitEnv(env) });
  return { ...plan, globalHooksPath: dir };
}

export function installedOwners(env: Env = process.env): string[] | null {
  const path = join(sharedHooksDir(env), "commit-msg");
  if (!existsSync(path)) return null;
  const line = /^case " (.*) " in$/m.exec(readFileSync(path, "utf8"));
  return line?.[1] === undefined ? [] : line[1].split(" ").filter(Boolean);
}

export function ownersCover(owners: string[], slug: string | null): boolean {
  return slug !== null && owners.map(foldAscii).includes(slug);
}

export type CommentGate =
  | { state: "unlabeled" }
  | { state: "off" | "uncovered" | "armed"; label: string }
  | { state: "hooks-elsewhere"; label: string; hooksPath: string | null };

export function commentsBanned(root: string, at: string, env: Env = process.env): boolean {
  return readConfig({ env, root, at }).comments === "banned";
}

export function commentGateFor(root: string, at: string, env: Env = process.env): CommentGate {
  const label = labelFor(root);
  if (label === null) return { state: "unlabeled" };
  if (!commentsBanned(root, at, env)) return { state: "off", label };
  if (!ownersCover(installedOwners(env) ?? [], checkoutSlug(root))) return { state: "uncovered", label };
  const hooksPath = hooksPathOf(root, env);
  if (hooksPath === null || canonicalPath(root, hooksPath) !== canonicalPath(root, sharedHooksDir(env))) {
    return { state: "hooks-elsewhere", label, hooksPath };
  }
  return { state: "armed", label };
}

function canonicalPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export type Checkout = { repo: string; owner: string };

export function checkoutDirs(checkouts: Checkout[], env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  return checkouts
    .map((c) => c.repo)
    .filter((r) => r.startsWith(join(home, "code")) && existsSync(join(r, ".git")));
}

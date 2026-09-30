import { spawnSync } from "node:child_process";
import { stagedComments } from "./comments-staged";
import { ConfigError } from "./config-error";
import { checkTask } from "./declared-tasks";
import { commentsBanned } from "./gate-comment";
import { type Gate, type GateInput, SKIP_CHECK_ENV } from "./gate-contract";
import { checkoutSlug } from "./git-remote";

const PREFIX = "pre-commit: ";

const COMMITTING_REPO_GIT_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
];

function bansComments(root: string, { env, say }: GateInput): boolean {
  try {
    return commentsBanned(root, "HEAD", env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    say(`${PREFIX}${error.message}, so comments are not judged.`);
    return false;
  }
}

function commentRefusal(root: string, input: GateInput): readonly string[] {
  if (!bansComments(root, input)) return [];
  const { found, unparsed } = stagedComments(root);
  for (const path of unparsed) input.say(`${PREFIX}${path} does not parse, so its comments are not judged.`);
  if (found.length === 0) return [];
  return [
    `${PREFIX}this repo bans code comments, and these added lines carry one:`,
    ...found.map(({ path, line }) => `  ${path}:${line}`),
    "  put the why in a name, a test, or the doc that owns the subject.",
    `  or ${SKIP_CHECK_ENV}=1 git commit to commit without this hook.`,
  ];
}

function checkRefusal(root: string, { env, say }: GateInput): readonly string[] {
  const declared = checkTask(root);
  if (!declared) return [];
  say(`${PREFIX}${declared.commandLine}`);
  const checkEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !COMMITTING_REPO_GIT_ENV.includes(name)),
  );
  const ran = spawnSync("sh", ["-c", declared.commandLine], {
    cwd: root,
    env: checkEnv,
    stdio: ["ignore", process.stderr.fd, process.stderr.fd],
  });
  if (ran.status === 0) return [];
  if (ran.status === null) {
    say(
      `${PREFIX}the check did not finish (${ran.error?.message ?? ran.signal}), so the commit is not judged.`,
    );
    return [];
  }
  return [
    `${PREFIX}the repo's own check failed, so the commit is refused.`,
    `  fix it, or ${SKIP_CHECK_ENV}=1 git commit to commit without it.`,
  ];
}

function refusal(input: GateInput): readonly string[] {
  if (input.env[SKIP_CHECK_ENV] === "1") return [];
  const comments = commentRefusal(input.cwd, input);
  return comments.length > 0 ? comments : checkRefusal(input.cwd, input);
}

export const preCommitGate: Gate = { owner: ({ cwd }) => checkoutSlug(cwd), refusal };

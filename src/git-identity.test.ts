import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentityEnv } from "./git-identity";

const operatorEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Operator",
  GIT_AUTHOR_EMAIL: "operator@example.com",
  GIT_COMMITTER_NAME: "Operator",
  GIT_COMMITTER_EMAIL: "operator@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Operator",
};

describe("committing with the repo's own identity", () => {
  test("an operator's git identity variables do not reach the commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-identity-"));
    try {
      const git = (args: string[], env = process.env) =>
        Bun.spawnSync(["git", "-C", repo, ...args], { env, stdout: "pipe", stderr: "pipe" });
      git(["init", "-q"]);
      git(["config", "user.name", "Repo"]);
      git(["config", "user.email", "repo@example.com"]);
      git(["config", "commit.gpgsign", "false"]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(["add", "a.txt"]);
      expect(git(["commit", "-q", "-m", "feat: add a"], repoIdentityEnv(operatorEnv)).success).toBe(true);
      const identity = git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).stdout.toString().trim();
      expect(identity).toBe("Repo <repo@example.com>|Repo <repo@example.com>");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("keeps every variable that is not an identity override", () => {
    const env = repoIdentityEnv({ PATH: "/bin", GIT_EDITOR: "true", GIT_AUTHOR_NAME: "Operator" });
    expect(env).toEqual({ PATH: "/bin", GIT_EDITOR: "true" });
  });
});

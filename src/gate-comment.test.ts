import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentGateFor } from "./gate-comment";
import { installCommitGate, sharedHooksDir } from "./gate-install";

describe("whether a checkout's commit is judged for comments", () => {
  test("arms under any spelling of the shared hooks directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "dim-comment-gate-for-"));
    try {
      const env = {
        HOME: join(dir, "home"),
        GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
        DIM_HOME: join(dir, "machine"),
      };
      mkdirSync(env.DIM_HOME, { recursive: true });
      mkdirSync(join(env.HOME, ".config", "dim"), { recursive: true });
      writeFileSync(join(env.HOME, ".config", "dim", "config.json"), '{ "comments": "banned" }');
      installCommitGate(["github.com/cniska"], [], env);
      const work = join(dir, "work");
      execFileSync("git", ["init", "-q", work]);
      execFileSync("git", ["-C", work, "remote", "add", "origin", "git@github.com:cniska/thing.git"]);
      execFileSync("git", ["-C", work, "config", "core.hooksPath", `${sharedHooksDir(env)}/`]);
      expect(commentGateFor(work, "HEAD", env)).toEqual({ state: "armed", label: "cniska/thing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

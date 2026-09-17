import { describe, expect, test } from "bun:test";
import { gitSubcommands } from "./git-command";

describe("reading git out of a shell command", () => {
  test("names the subcommand", () => {
    expect(gitSubcommands("git status --short")).toEqual(["status"]);
    expect(gitSubcommands("git log --oneline -3")).toEqual(["log"]);
  });

  // One Bash call is one tool_call row and often several operations; counting it
  // as one would hide every commit made in the same breath as an add.
  test("names every subcommand a chained call runs, in order", () => {
    expect(gitSubcommands('git add -A && git commit -m "feat: a thing"')).toEqual(["add", "commit"]);
    expect(gitSubcommands("git fetch; git rebase origin/main || git rebase --abort")).toEqual([
      "fetch",
      "rebase",
      "rebase",
    ]);
  });

  // The conventions send an agent to /usr/bin/git inside a worktree, so the
  // absolute path is the common spelling here, not an edge case.
  test("reads git through a path, an env assignment or sudo", () => {
    expect(gitSubcommands("/usr/bin/git rev-parse HEAD")).toEqual(["rev-parse"]);
    expect(gitSubcommands("GIT_EDITOR=true git rebase --continue")).toEqual(["rebase"]);
  });

  test("skips the global flags that carry a value", () => {
    expect(gitSubcommands("git -C /tmp/repo status")).toEqual(["status"]);
    expect(gitSubcommands("git -c user.name=T commit -m x")).toEqual(["commit"]);
    expect(gitSubcommands("git --no-pager diff")).toEqual(["diff"]);
  });

  // `.git` appears in arguments far more often than git is run, so a match on
  // the word anywhere would report more operations than actually happened.
  test("ignores git named as anything but the command", () => {
    expect(gitSubcommands("grep -r x --exclude-dir=.git .")).toEqual([]);
    expect(gitSubcommands("ls -la .git/hooks")).toEqual([]);
    expect(gitSubcommands("echo 'run git status'")).toEqual([]);
    expect(gitSubcommands("gh pr view 106 --json state")).toEqual([]);
  });

  test("reports nothing rather than a guess when no subcommand follows", () => {
    expect(gitSubcommands("git")).toEqual([]);
    expect(gitSubcommands("git --version")).toEqual([]);
  });

  test("finds git after another command in the same line", () => {
    expect(gitSubcommands("cd api && git status --porcelain")).toEqual(["status"]);
    expect(gitSubcommands("mise run verify 2>&1 | tail -2 && /usr/bin/git add -A")).toEqual(["add"]);
  });
});

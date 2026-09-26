import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot } from "./git-checkout";

const scratch = (): string => mkdtempSync(join(tmpdir(), "dim-checkout-"));

describe("finding the checkout a directory belongs to", () => {
  test("climbs out of a subdirectory to the root", () => {
    const repo = scratch();
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "src", "deep"), { recursive: true });
      expect(checkoutRoot(join(repo, "src", "deep"))).toBe(repo);
      expect(checkoutRoot(repo)).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reads a worktree, where .git is a file", () => {
    const wt = scratch();
    try {
      writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
      mkdirSync(join(wt, "src"));
      expect(checkoutRoot(join(wt, "src"))).toBe(wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("answers nothing outside a checkout, not the directory it was asked about", () => {
    const bare = scratch();
    try {
      mkdirSync(join(bare, "sub"));
      expect(checkoutRoot(join(bare, "sub"))).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

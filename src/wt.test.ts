import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWt, planWt, wtSource, wtTestPath } from "./wt";

const scratch = () => mkdtempSync(join(tmpdir(), "dim-wt-"));

describe("adopting wt", () => {
  test("ships the script and the suite that proves it works", () => {
    expect(existsSync(wtSource())).toBe(true);
    expect(existsSync(wtTestPath())).toBe(true);
    expect(readFileSync(wtSource(), "utf8")).toStartWith("#!/usr/bin/env bash");
  });

  test("reports the link missing before it is made, and linked after", () => {
    const dir = scratch();
    try {
      const env = { DIM_WT_BIN: join(dir, "wt") };
      expect(planWt(env).state).toBe("missing");
      installWt(env);
      expect(planWt(env).state).toBe("linked");
      expect(readlinkSync(join(dir, "wt"))).toBe(wtSource());
      expect(lstatSync(join(dir, "wt")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The script being replaced is the only copy of itself on the machine, so it
  // is renamed aside. Deleting it would take the working tool with it.
  test("keeps whatever it replaces", () => {
    const dir = scratch();
    try {
      const link = join(dir, "wt");
      writeFileSync(link, "#!/bin/sh\necho the one that was there\n");
      const env = { DIM_WT_BIN: link };
      expect(planWt(env).state).toBe("occupied");

      installWt(env);
      expect(readlinkSync(link)).toBe(wtSource());
      expect(readFileSync(`${link}.dim-backup`, "utf8")).toContain("the one that was there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installing twice changes nothing", () => {
    const dir = scratch();
    try {
      const env = { DIM_WT_BIN: join(dir, "wt") };
      installWt(env);
      installWt(env);
      expect(existsSync(join(dir, "wt.dim-backup"))).toBe(false);
      expect(planWt(env).state).toBe("linked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

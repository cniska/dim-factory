import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchEnv } from "./fixtures.test-support";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

test("a decision or cancel whose reason is blank is refused as usage", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-order-command-"));
  roots.push(root);
  for (const args of [
    ["approve", "k7m2qx4d", "--reason", "  ", "--decided", "owner"],
    ["return", "k7m2qx4d", "--reason", "", "--decided", "operator"],
    ["cancel", "k7m2qx4d", "--reason", " "],
  ]) {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "cli.ts"), "order", ...args], {
      env: { ...process.env, ...scratchEnv(root) },
    });
    expect({ args, exitCode: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({
      args,
      exitCode: 1,
      stderr: expect.stringContaining('"code":"usage"'),
    });
  }
});

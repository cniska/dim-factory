import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("install-hooks preview leaves the data directory untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-preview-"));
  const data = join(root, "data");
  try {
    const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "install-hooks"], {
      env: { ...process.env, HOME: root, DIM_HOME: data },
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(data)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

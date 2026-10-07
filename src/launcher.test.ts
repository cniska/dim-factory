import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER = resolve(import.meta.dir, "..", "bin", "dim");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("runs dim under its own pinned bun, whichever bun the caller's PATH finds first", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "dim-launcher-"));
  roots.push(elsewhere);
  writeFileSync(join(elsewhere, "bun"), "#!/bin/sh\necho 'a project bun ran dim' >&2\nexit 3\n");
  chmodSync(join(elsewhere, "bun"), 0o755);
  const ran = Bun.spawnSync([LAUNCHER], {
    cwd: elsewhere,
    env: { ...process.env, PATH: `${elsewhere}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(ran.stderr.toString()).toBe("");
  expect(JSON.parse(ran.stdout.toString())).toMatchObject({ command: "dim", ok: true });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGroup } from "./process-group";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dim-group-test-")));
  dirs.push(dir);
  return dir;
}

const run = (dir: string, script: string, limitMs: number) =>
  runGroup(["sh", "-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, limitMs });

describe("a process group run", () => {
  test("returns its exit code and output", () => {
    expect(run(scratch(), "echo RED; echo ERR >&2; exit 3", 5000)).toEqual({
      exitCode: 3,
      output: "RED\nERR\n",
      timedOut: false,
    });
  });

  test("that runs past its limit is stopped with everything it started", async () => {
    const dir = scratch();
    const ran = run(dir, `(sleep 1; touch "${dir}/late") & sleep 30`, 300);
    await Bun.sleep(1500);
    expect(ran.timedOut).toBe(true);
    expect(ran.exitCode).toBeNull();
    expect(existsSync(join(dir, "late"))).toBe(false);
  });

  test("that ends leaves nothing it started running", async () => {
    const dir = scratch();
    run(dir, `(sleep 1; touch "${dir}/late") >/dev/null 2>&1 & echo done`, 5000);
    await Bun.sleep(1500);
    expect(existsSync(join(dir, "late"))).toBe(false);
  });
});

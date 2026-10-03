import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorSession } from "./operator-session";
import { alive } from "./processes";
import { waitFor } from "./wait";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("closing a session stops every process it started, even one still running", async () => {
  const root = mkdtempSync(join(tmpdir(), "dim-operator-session-test-"));
  roots.push(root);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_STATE_HOME: root,
    TMPDIR: root,
    PATH: process.env.PATH ?? "",
  };
  const session = OperatorSession.open(env, root);
  const pidFile = join(root, "sleeper");
  const running = session.sh(`sleep 30 & echo $! > ${pidFile}; wait`);
  await waitFor(
    "the sleeper to start",
    () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
  );
  const sleeper = Number(readFileSync(pidFile, "utf8"));

  session.close();

  await expect(running).rejects.toThrow("closed");
  await Bun.sleep(200);
  expect(alive(sleeper)).toBe(false);
});

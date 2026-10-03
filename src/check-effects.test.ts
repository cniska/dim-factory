import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputTail } from "./check";
import { runCheck } from "./check-effects";
import type { Trace } from "./trace-contract";
import { traceOf } from "./trace-ops";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function scratch(): { tree: string; outside: string; trace: Trace } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dim-check-test-")));
  roots.push(root);
  const tree = join(root, "tree");
  const outside = join(root, "outside");
  mkdirSync(tree);
  mkdirSync(outside);
  return { tree, outside, trace: traceOf("k7m2qx4d", { XDG_STATE_HOME: join(root, "state") }) };
}

const OWNER = { PATH: process.env.PATH };

const LIMIT_MS = 5000;

describe("a check run", () => {
  test("records its command, exit code and output", () => {
    const { tree, trace } = scratch();
    expect(runCheck(trace, tree, "echo RED; exit 3", OWNER, LIMIT_MS)).toEqual({
      kind: "check",
      command: "echo RED; exit 3",
      exitCode: 3,
      output: "RED\n",
    });
  });

  test("writes inside the tree it checks and its own temp directory, and nowhere else", () => {
    const { tree, outside, trace } = scratch();
    const ran = runCheck(
      trace,
      tree,
      `touch "${tree}/inside" && touch "$TMPDIR/tmp" && touch "${outside}/escaped"; echo done`,
      OWNER,
      LIMIT_MS,
    );
    expect(ran.output).toContain("done");
    expect(existsSync(join(tree, "inside"))).toBe(true);
    expect(existsSync(join(outside, "escaped"))).toBe(false);
  });

  test("sees none of the owner's keys or sign-in, and its caches sit in its temp directory", () => {
    const { tree, trace } = scratch();
    const owner = {
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      HOME: "/owner",
    };
    const ran = runCheck(
      trace,
      tree,
      'echo "[$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN]"; echo "$HOME" "$XDG_CACHE_HOME"',
      owner,
      LIMIT_MS,
    );
    const [keys, dirs] = ran.output.trim().split("\n");
    expect(keys).toBe("[]");
    expect(dirs).not.toContain("/owner");
    expect(dirs?.split(" ")[1]).toStartWith(dirs?.split(" ")[0] ?? "");
  });
});

describe("a check that runs past its limit", () => {
  test("is stopped with everything it started, and its output says it hit the limit", async () => {
    const { tree, trace } = scratch();
    const ran = runCheck(trace, tree, `(sleep 1; touch "${tree}/late") & sleep 30`, OWNER, 300);
    await Bun.sleep(1500);
    expect(ran.exitCode).toBeNull();
    expect(ran.output).toEndWith("stopped: the check ran past its 300 ms limit\n");
    expect(existsSync(join(tree, "late"))).toBe(false);
  });
});

describe("a check that ends", () => {
  test("leaves nothing it started running", async () => {
    const { tree, trace } = scratch();
    runCheck(trace, tree, `(sleep 1; touch "${tree}/late") >/dev/null 2>&1 & echo done`, OWNER, LIMIT_MS);
    await Bun.sleep(1500);
    expect(existsSync(join(tree, "late"))).toBe(false);
  });
});

describe("a check's output", () => {
  test("keeps the end of an output longer than the cap, where a failure says what failed", () => {
    const long = `${"x".repeat(65536)}FAILED: the last line`;
    const kept = outputTail(long);
    expect(Buffer.byteLength(kept)).toBe(65536);
    expect(kept.endsWith("FAILED: the last line")).toBe(true);
    expect(outputTail("short")).toBe("short");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_OUTPUT_TAIL_BYTES, outputTail } from "./check";
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

describe("a check run", () => {
  test("records its command, exit code and output", () => {
    const { tree, trace } = scratch();
    expect(runCheck(trace, tree, "echo RED; exit 3", OWNER)).toEqual({
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
    );
    const [keys, dirs] = ran.output.trim().split("\n");
    expect(keys).toBe("[]");
    expect(dirs).not.toContain("/owner");
    expect(dirs?.split(" ")[1]).toStartWith(dirs?.split(" ")[0] ?? "");
  });
});

describe("a check's output", () => {
  test("keeps the end of an output longer than the cap, where a failure says what failed", () => {
    const long = `${"x".repeat(CHECK_OUTPUT_TAIL_BYTES)}FAILED: the last line`;
    const kept = outputTail(long);
    expect(Buffer.byteLength(kept)).toBe(CHECK_OUTPUT_TAIL_BYTES);
    expect(kept.endsWith("FAILED: the last line")).toBe(true);
    expect(outputTail("short")).toBe("short");
  });
});

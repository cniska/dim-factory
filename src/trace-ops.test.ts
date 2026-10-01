import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuser } from "./coded-error";
import { tracePath } from "./paths";
import { clearTrace, traceOf } from "./trace-ops";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function scratchEnv() {
  const root = mkdtempSync(join(tmpdir(), "dim-trace-"));
  roots.push(root);
  return { XDG_STATE_HOME: root };
}

const linesOf = (env: { XDG_STATE_HOME: string }) =>
  readFileSync(tracePath(env), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const refuse = refuser<{ held: { readonly path: string } }>({
  held: { message: ({ path }) => `${path} is held`, resolve: () => "dim doctor" },
});

describe("a trace step", () => {
  test("writes a started line with its fields and an ended line with its time, outcome and result", () => {
    const env = scratchEnv();
    const trace = traceOf("k7m2qx4d", 7, env);

    const done = trace.step(
      "check",
      { tree: "/w", command: "true" },
      () => 3,
      (code) => ({ exitCode: code }),
    );

    expect(done).toBe(3);
    const [started, ended] = linesOf(env);
    expect(started).toMatchObject({
      order: "k7m2qx4d",
      cause: 7,
      seq: 1,
      step: "check",
      phase: "started",
      tree: "/w",
      command: "true",
    });
    expect(ended).toMatchObject({
      seq: 2,
      step: "check",
      phase: "ended",
      outcome: { kind: "ok" },
      exitCode: 3,
    });
    expect(ended.ms).toBeNumber();
  });

  test("ends a step that throws a refusal as refused with its code, and one that throws anything else as failed", async () => {
    const env = scratchEnv();
    const trace = traceOf("k7m2qx4d", 7, env);

    expect(() =>
      trace.step("lock", { path: "/l" }, () => {
        throw refuse("held", { path: "/l" });
      }),
    ).toThrow();
    await expect(
      trace.stepAsync("harness_wait", { pid: 1 }, async () => {
        throw new Error("gone");
      }),
    ).rejects.toThrow("gone");

    const ended = linesOf(env).filter((line) => line.phase === "ended");
    expect(ended.map((line) => line.outcome)).toEqual([
      { kind: "refused", code: "held" },
      { kind: "failed", error: "gone" },
    ]);
  });

  test("is emptied by clearing the trace", () => {
    const env = scratchEnv();
    traceOf("k7m2qx4d", 7, env).step("lock", { path: "/l" }, () => null);

    clearTrace(env);

    expect(readFileSync(tracePath(env), "utf8")).toBe("");
  });
});

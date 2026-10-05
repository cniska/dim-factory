import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "./assert";
import { refuser } from "./coded-error";
import { tracePath } from "./paths";
import { followTrace, traceOf } from "./trace-ops";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  held: { message: ({ path }) => `${path} is held`, resolve: ({ path }) => `release ${path}` },
});

describe("a trace step", () => {
  test("writes a started line with its fields and an ended line with its time, outcome and result", () => {
    const env = scratchEnv();
    const trace = traceOf("k7m2qx4d", env);

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
      pid: process.pid,
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

  test("keys every line by the writing process, apart from a process the step acts on", () => {
    const env = scratchEnv();

    traceOf("k7m2qx4d", env).step("harness_kill", { harness: 99 }, () => null);

    expect(linesOf(env)).toMatchObject([
      { pid: process.pid, harness: 99, phase: "started" },
      { pid: process.pid, phase: "ended" },
    ]);
  });

  test("ends a step that throws a refusal as refused with its code, and one that throws anything else as failed", async () => {
    const env = scratchEnv();
    const trace = traceOf("k7m2qx4d", env);

    expect(() =>
      trace.step("lock", { path: "/l" }, () => {
        throw refuse("held", { path: "/l" });
      }),
    ).toThrow();
    await expect(
      trace.stepAsync("lock", { path: "/m" }, async () => {
        throw new Error("gone");
      }),
    ).rejects.toThrow("gone");
    expect(() => trace.step("lock", { path: "/n" }, () => invariant(false, "the lock is held"))).toThrow();

    const ended = linesOf(env).filter((line) => line.phase === "ended");
    expect(ended.map((line) => line.outcome)).toEqual([
      { kind: "refused", code: "held" },
      { kind: "failed", error: "gone" },
      { kind: "failed", error: "invariant failed: the lock is held" },
    ]);
  });
});

describe("following the trace", () => {
  test("prints only the order's lines and ends once the order has no live run and no new lines", async () => {
    const env = scratchEnv();
    traceOf("k7m2qx4d", env).step("lock", { path: "/l" }, () => null);
    traceOf("p3n8wz2c", env).step("lock", { path: "/o" }, () => null);
    const printed: string[] = [];
    let polls = 0;

    await followTrace(
      "k7m2qx4d",
      env,
      () => {
        polls += 1;
        return polls < 3;
      },
      (line) => printed.push(line),
    );

    expect(printed.map((line) => JSON.parse(line))).toMatchObject([
      { order: "k7m2qx4d", phase: "started" },
      { order: "k7m2qx4d", phase: "ended" },
    ]);
    expect(polls).toBe(3);
  });

  test("prints a line whose bytes arrive across two polls, split inside a character, intact", async () => {
    const env = scratchEnv();
    const path = tracePath(env);
    const line = Buffer.from(`${JSON.stringify({ order: "k7m2qx4d", step: "lock", path: "/tmp/är" })}\n`);
    const cut = line.indexOf(Buffer.from("ä")) + 1;
    const second = Buffer.from(`${JSON.stringify({ order: "k7m2qx4d", step: "lock", path: "/b" })}\n`);
    const writes = [line.subarray(0, cut), Buffer.concat([line.subarray(cut), second])];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    const printed: string[] = [];
    let polls = 0;

    await followTrace(
      "k7m2qx4d",
      env,
      () => {
        const next = writes[polls];
        if (next !== undefined) appendFileSync(path, next);
        polls += 1;
        return polls <= writes.length;
      },
      (printedLine) => printed.push(printedLine),
    );

    expect(printed.map((printedLine) => JSON.parse(printedLine).path)).toEqual(["/tmp/är", "/b"]);
  });

  test("fails on a line that names no order, rather than skipping it", async () => {
    const env = scratchEnv();
    const path = tracePath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ order: 7, step: "lock" })}\n`);

    await expect(
      followTrace(
        "k7m2qx4d",
        env,
        () => false,
        () => {},
      ),
    ).rejects.toThrow();
  });
});

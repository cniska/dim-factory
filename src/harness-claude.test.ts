import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claude } from "./harness-claude";
import type { Start } from "./harness-contract";

const START: Start = {
  session: { kind: "new", id: "s1" },
  model: "opus",
  policy: { kind: "read", writable: ["/t"], denied: ["/w"] },
  socket: "/t/s",
};

const argvMode = (argv: readonly string[]) => argv[argv.indexOf("--permission-mode") + 1];

const settingsOf = (argv: readonly string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "");

describe("starting Claude Code", () => {
  test("starts a new session under its id and resumes one by its id, reading no project settings", () => {
    const argv = claude.argv(START);
    expect(argv.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    expect(argv.slice(-2)).toEqual(["--session-id", "s1"]);
    expect(claude.argv({ ...START, session: { kind: "resume", id: "s1" } }).slice(-2)).toEqual([
      "--resume",
      "s1",
    ]);
  });

  test("replaces a dead session by forking its transcript under the new session's id", () => {
    expect(claude.argv({ ...START, session: { kind: "fork", id: "s2", from: "s1" } }).slice(-5)).toEqual([
      "--resume",
      "s1",
      "--fork-session",
      "--session-id",
      "s2",
    ]);
  });

  test("loads dim's station skills as the dim plugin, since a worker's HOME holds none", () => {
    const argv = claude.argv(START);
    const plugin = argv[argv.indexOf("--plugin-dir") + 1] ?? "";
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("dim");
    for (const skill of ["dim-plan", "dim-build", "dim-review"]) {
      expect(existsSync(join(plugin, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  test("turns a read policy into Claude's sandbox, with every edit tool denied and only the turn's socket reachable", () => {
    const settings = settingsOf(claude.argv(START));
    expect(settings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["/t"], denyWrite: ["/w"] },
      network: { allowUnixSockets: ["/t/s"] },
    });
    expect(settings.permissions.deny).toEqual(["Write", "Edit", "NotebookEdit"]);
    expect(argvMode(claude.argv(START))).toBe("default");
  });

  test("turns an edit policy into acceptEdits, with the edit tool allowed the writable directories, and Bash and the edit tool both denied the policy's directories", () => {
    const edit: Start = {
      ...START,
      policy: { kind: "edit", writable: ["/t"], denied: ["/w/.git/hooks", "/c/.git"] },
    };
    const argv = claude.argv(edit);
    expect(argvMode(argv)).toBe("acceptEdits");
    expect(settingsOf(argv).permissions.allow).toEqual(["Edit(//t/**)"]);
    expect(settingsOf(argv).permissions.deny).toEqual(["Edit(//w/.git/hooks/**)", "Edit(//c/.git/**)"]);
    expect(settingsOf(argv).sandbox.filesystem).toEqual({
      allowWrite: ["/t"],
      denyWrite: ["/w/.git/hooks", "/c/.git"],
    });
  });
});

const ended = (events: readonly object[], exitCode: number | null = 0) => ({
  lines: events.map((event) => JSON.stringify(event)),
  stderr: "",
  exitCode,
});

const INIT = { type: "system", subtype: "init", session_id: "s1" };
const RESULT = { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" };
const NEW = { kind: "new", id: "s1" } as const;
const RESUME = { kind: "resume", id: "s1" } as const;

describe("how a Claude Code session ended", () => {
  test("a session that reported its result finished", () => {
    expect(claude.outcome(ended([INIT, RESULT]), NEW)).toEqual({ kind: "finished" });
  });

  test("a rejected rate limit is a usage limit, with the time it resets", () => {
    const limited = ended(
      [
        INIT,
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1759276800 } },
        { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" },
      ],
      1,
    );
    expect(claude.outcome(limited, NEW)).toEqual({
      kind: "died",
      code: "usage_limit",
      resetsAt: "2025-10-01T00:00:00.000Z",
    });
  });

  test("a session that stopped with no result was killed", () => {
    expect(claude.outcome(ended([INIT], null), NEW)).toEqual({ kind: "died", code: "killed" });
  });

  test("a resume or fork that never started its session failed", () => {
    expect(claude.outcome(ended([], 1), RESUME)).toEqual({ kind: "died", code: "resume_failed" });
    expect(claude.outcome(ended([], 1), { kind: "fork", id: "s2", from: "s1" })).toEqual({
      kind: "died",
      code: "resume_failed",
    });
    expect(claude.outcome(ended([], 1), NEW)).toEqual({ kind: "died", code: "killed" });
  });
});

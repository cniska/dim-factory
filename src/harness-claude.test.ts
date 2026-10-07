import { describe, expect, test } from "bun:test";
import { claude } from "./harness-claude";
import type { Start } from "./harness-contract";

const START: Start = {
  session: { kind: "new", id: "s1" },
  model: "opus",
  instructions: "# Build",
  policy: { writable: ["/t"], denied: ["/w"], edits: true, web: false },
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

  test("gives the worker its station's instructions in the system prompt and loads no plugin", () => {
    const argv = claude.argv(START);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("# Build");
    expect(argv).not.toContain("--plugin-dir");
  });

  test("runs every worker in acceptEdits under Claude's sandbox, with only the turn's socket reachable and local ports bindable for a project's own test servers", () => {
    const argv = claude.argv(START);
    expect(argvMode(argv)).toBe("acceptEdits");
    expect(settingsOf(argv).sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["/t"], denyWrite: ["/w"] },
      network: { allowUnixSockets: ["/t/s"], allowLocalBinding: true },
    });
  });

  test("allows the edit tool the writable directories, and denies Bash and the edit tool both the policy's directories", () => {
    const argv = claude.argv({
      ...START,
      policy: { ...START.policy, denied: ["/w/.git/hooks", "/c/.git"] },
    });
    expect(settingsOf(argv).permissions.allow).toEqual(["Edit(//t/**)"]);
    expect(settingsOf(argv).permissions.deny).toEqual(["Edit(//w/.git/hooks/**)", "Edit(//c/.git/**)"]);
    expect(settingsOf(argv).sandbox.filesystem).toEqual({
      allowWrite: ["/t"],
      denyWrite: ["/w/.git/hooks", "/c/.git"],
    });
  });

  test("offers the edit tool only when the policy edits, so a worker that may not edit still writes through its programs", () => {
    const toolsOf = (argv: readonly string[]) => argv[argv.indexOf("--tools") + 1];
    expect(toolsOf(claude.argv(START))).toBe("Bash,Read,Write,Agent,Edit");
    const argv = claude.argv({ ...START, policy: { ...START.policy, denied: [], edits: false } });
    expect(toolsOf(argv)).toBe("Bash,Read,Write,Agent");
    expect(settingsOf(argv).permissions.deny).toEqual([]);
    expect(settingsOf(argv).sandbox.filesystem).toEqual({ allowWrite: ["/t"], denyWrite: [] });
  });

  test("allows web search and fetch only when the policy gives the web", () => {
    expect(settingsOf(claude.argv(START)).permissions.allow).toEqual(["Edit(//t/**)"]);
    const argv = claude.argv({ ...START, policy: { ...START.policy, web: true } });
    expect(settingsOf(argv).permissions.allow).toEqual(["Edit(//t/**)", "WebSearch", "WebFetch"]);
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
  test("a session that reported its result finished, with the result's text", () => {
    expect(claude.outcome(ended([INIT, RESULT]), NEW)).toEqual({ kind: "finished", result: "done" });
  });

  test("a session whose result carries no text finished with none", () => {
    const failed = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" };
    expect(claude.outcome(ended([INIT, failed], 1), NEW)).toEqual({ kind: "finished", result: null });
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

  test("a resume that never started its session failed", () => {
    expect(claude.outcome(ended([], 1), RESUME)).toEqual({ kind: "died", code: "resume_failed" });
    expect(claude.outcome(ended([], 1), NEW)).toEqual({ kind: "died", code: "killed" });
  });
});

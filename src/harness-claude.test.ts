import { describe, expect, test } from "bun:test";
import { claude } from "./harness-claude";

const line = (event: Readonly<Record<string, unknown>>) => JSON.stringify(event);

const INIT = line({ type: "system", subtype: "init", session_id: "s1" });

describe("the Claude Code stream", () => {
  test("finishes with the text of its successful result", () => {
    const lines = [INIT, line({ type: "result", subtype: "success", is_error: false, result: "planned" })];
    expect(claude.outcome(lines)).toEqual({ kind: "finished", text: "planned" });
  });

  test("is limited when a rate limit was rejected, with the time it resets", () => {
    const lines = [
      INIT,
      line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000 } }),
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "usage limit reached",
      }),
    ];
    expect(claude.outcome(lines)).toEqual({ kind: "limited", resetsAt: "2026-09-21T14:13:20.000Z" });
  });

  test("is unfinished when it ends with no result, or with an error", () => {
    expect(claude.outcome([INIT])).toEqual({ kind: "unfinished" });
    const errored = line({ type: "result", subtype: "error_during_execution", is_error: true });
    expect(claude.outcome([INIT, errored])).toEqual({ kind: "unfinished" });
  });
});

describe("starting Claude Code", () => {
  const start = {
    session: { kind: "new", id: "s1" },
    model: "opus",
    workspace: "/w",
    tmp: "/t",
    socket: "/t/s",
  } as const;

  test("starts a new session under its id, reading no project settings", () => {
    const argv = claude.argv(start);
    expect(argv.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
    expect(argv.slice(-4)).toEqual(["--setting-sources", "user", "--session-id", "s1"]);
    expect(claude.argv({ ...start, session: { kind: "resume", id: "s1" } }).slice(-2)).toEqual([
      "--resume",
      "s1",
    ]);
  });

  test("sandboxes the worker so it writes only its turn's temp directory and reaches only its socket", () => {
    const argv = claude.argv(start);
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "");
    expect(settings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["/t"], denyWrite: ["/w"] },
      network: { allowUnixSockets: ["/t/s"] },
    });
    expect(settings.permissions.deny).toEqual(["Write", "Edit", "NotebookEdit"]);
  });
});

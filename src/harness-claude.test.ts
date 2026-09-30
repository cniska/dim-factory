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

  test("turns an edit policy into acceptEdits, with the edit tool denied the git paths the policy names", () => {
    const edit: Start = {
      ...START,
      policy: {
        kind: "edit",
        writable: ["/t"],
        denied: ["/w/.git/config"],
        editDenied: ["/w/.git", "/c/.git"],
      },
    };
    const argv = claude.argv(edit);
    expect(argvMode(argv)).toBe("acceptEdits");
    expect(settingsOf(argv).permissions.deny).toEqual(["Edit(//w/.git/**)", "Edit(//c/.git/**)"]);
    expect(settingsOf(argv).sandbox.filesystem).toEqual({
      allowWrite: ["/t"],
      denyWrite: ["/w/.git/config"],
    });
  });
});

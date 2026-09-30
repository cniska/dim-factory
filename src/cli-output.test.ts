import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { UsageError } from "./cli-contract";
import { writeError } from "./cli-output";
import { CodedError } from "./coded-error";

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function printed(error: unknown, usage = "usage: dim gate check <range>"): unknown {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  writeError("gate", error, usage);
  return JSON.parse(lines.join(""));
}

describe("an error on stderr", () => {
  test("carries a refusal's code, facts and the command that resolves it beside its message", () => {
    const refused = new CodedError(
      "gate_commits_unenumerable",
      "cannot enumerate main..HEAD",
      { range: "main..HEAD" },
      "dim gate check main..HEAD",
    );
    expect(printed(refused)).toEqual({
      command: "gate",
      ok: false,
      error: {
        code: "gate_commits_unenumerable",
        message: "cannot enumerate main..HEAD",
        meta: { range: "main..HEAD" },
        resolve: "dim gate check main..HEAD",
      },
    });
  });

  test("resolves a usage error with the command's usage", () => {
    expect(printed(new UsageError("gate check needs a range"))).toMatchObject({
      error: { code: "usage", resolve: "dim gate check <range>" },
    });
  });

  test("names an error that is not a refusal as an unexpected failure, resolved by the doctor", () => {
    expect(printed(new Error("disk full"))).toMatchObject({
      error: { code: "command_failed", message: "disk full", meta: {}, resolve: "dim doctor" },
    });
  });
});

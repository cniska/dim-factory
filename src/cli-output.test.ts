import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeError } from "./cli-output";
import { CodedError } from "./coded-error";

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function printed(error: unknown): unknown {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  writeError("gate", error);
  return JSON.parse(lines.join(""));
}

describe("an error on stderr", () => {
  test("carries a coded error's code and facts beside its message", () => {
    const refused = new CodedError("gate_refused", "the check failed at abc123", { head: "abc123" });
    expect(printed(refused)).toEqual({
      command: "gate",
      ok: false,
      error: {
        name: "CodedError",
        code: "gate_refused",
        message: "the check failed at abc123",
        meta: { head: "abc123" },
      },
    });
  });

  test("names an error that is not a domain code as an unexpected failure", () => {
    expect(printed(new Error("disk full"))).toEqual({
      command: "gate",
      ok: false,
      error: { name: "Error", code: "command_failed", message: "disk full" },
    });
  });
});

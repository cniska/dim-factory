import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { UsageError } from "./cli-contract";
import { writeError } from "./cli-output";
import { CodedError } from "./coded-error";

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function printed(error: unknown, usage = "usage: dim trace <order>"): unknown {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  writeError("trace", error, usage);
  return JSON.parse(lines.join(""));
}

describe("an error on stderr", () => {
  test("carries a refusal's code, facts and the command that resolves it beside its message", () => {
    const refused = new CodedError(
      "no_order",
      "no order k7m2qx4d is on record",
      { order: "k7m2qx4d" },
      "dim order add --title <title> --description <description>",
    );
    expect(printed(refused)).toEqual({
      command: "trace",
      ok: false,
      error: {
        code: "no_order",
        message: "no order k7m2qx4d is on record",
        meta: { order: "k7m2qx4d" },
        resolve: "dim order add --title <title> --description <description>",
      },
    });
  });

  test("resolves a usage error with the command's usage", () => {
    expect(printed(new UsageError("trace takes an order"))).toMatchObject({
      error: { code: "usage", resolve: "dim trace <order>" },
    });
  });

  test("names an error that is not a refusal as an unexpected failure, resolved by the doctor", () => {
    expect(printed(new Error("disk full"))).toMatchObject({
      error: { code: "command_failed", message: "disk full", meta: {}, resolve: "dim doctor" },
    });
  });
});

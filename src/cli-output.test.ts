import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeError } from "./cli-output";
import { fail } from "./order-contract";

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function printed(error: unknown): unknown {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  writeError("order", error);
  return JSON.parse(lines.join(""));
}

describe("an error on stderr", () => {
  test("carries a coded error's code and facts beside its message", () => {
    expect(printed(fail("order_not_checked", { orderId: "o-1" }))).toEqual({
      command: "order",
      ok: false,
      error: {
        name: "CodedError",
        code: "order_not_checked",
        message: "order o-1 has no check that passed at its last commit",
        meta: { orderId: "o-1" },
      },
    });
  });

  test("names an error that is not a domain code as an unexpected failure", () => {
    expect(printed(new Error("disk full"))).toEqual({
      command: "order",
      ok: false,
      error: { name: "Error", code: "command_failed", message: "disk full" },
    });
  });
});

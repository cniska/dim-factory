import { describe, expect, test } from "bun:test";
import { CodedError } from "./coded-error";
import { fail } from "./order-contract";

describe("an order error", () => {
  test("is built from its code and facts, and carries both", () => {
    const error = fail("order_held_by_run", {
      orderId: "o-1",
      worker: "nut-7",
      runId: "run-1",
      act: "be dropped",
    });
    expect(error).toBeInstanceOf(CodedError);
    expect(error.code).toBe("order_held_by_run");
    expect(error.meta).toEqual({ orderId: "o-1", worker: "nut-7", runId: "run-1", act: "be dropped" });
    expect(error.message).toBe("order o-1 is being worked by nut-7 under run-1, so it cannot be dropped");
  });

  test("words each refusal from its facts alone", () => {
    expect(fail("order_not_checked", { orderId: "o-1" }).message).toBe(
      "order o-1 has no check that passed at its last commit",
    );
    expect(fail("order_not_queued", { orderId: "o-1", status: "running", act: "started" }).message).toBe(
      "order o-1 is running and only a queued order can be started",
    );
    expect(fail("order_terminal", { orderId: "o-1", status: "shipped", act: "build" }).message).toBe(
      "order o-1 is shipped, so it cannot build",
    );
    expect(fail("not_next", { orderId: "o-1", waitsOn: "run at build", act: "review" }).message).toBe(
      "order o-1 waits on run at build, so it cannot review",
    );
  });
});

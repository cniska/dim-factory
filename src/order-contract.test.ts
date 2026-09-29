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
    expect(error.message).toBe(
      "order o-1 is being worked by nut-7 under run-1, so it cannot be dropped; wait for that run to finish, which `dim q order o-1` shows",
    );
  });

  test("names the command that resolves a refusal, so a model reading it knows what to run", () => {
    expect(fail("not_next", { orderId: "o-1", station: "build", next: "run", act: "review" }).message).toBe(
      "order o-1 waits on run at build, so it cannot review; its next act is `dim order build o-1`",
    );
    expect(
      fail("not_next", { orderId: "o-1", station: "build", next: "approve", act: "review" }).message,
    ).toBe(
      'order o-1 waits on approve at build, so it cannot review; its next act is `dim order approve o-1 --reason "..."`',
    );
    expect(
      fail("not_next", { orderId: "o-1", station: "review", next: "approve", act: "build" }).message,
    ).toBe(
      "order o-1 waits on approve at review, so it cannot build; its next act is `dim order approve o-1`",
    );
    expect(fail("not_next", { orderId: "o-1", station: null, next: "ship", act: "build" }).message).toBe(
      "order o-1 waits on ship, so it cannot build; its next act is `dim order ship o-1`",
    );
    expect(fail("rebase_conflict_pending", { orderId: "o-1", act: "return" }).message).toBe(
      "order o-1 has a rebase conflict the builder must resolve, so it cannot return; `dim order build o-1` resolves it first",
    );
  });

  test("refuses work on an order that is not running, and says what starts it", () => {
    expect(fail("order_not_running", { orderId: "o-1", status: "queued" }).message).toBe(
      "order o-1 is not started; `dim order plan o-1` starts it",
    );
    expect(fail("order_not_running", { orderId: "o-1", status: "dropped" }).message).toBe(
      "order o-1 is already dropped; nothing more runs on a dropped order",
    );
  });

  test("says when nothing resolves a refusal", () => {
    expect(fail("order_terminal", { orderId: "o-1", status: "shipped", act: "build" }).message).toBe(
      "order o-1 is shipped, so it cannot build; nothing more runs on a shipped order",
    );
  });
});

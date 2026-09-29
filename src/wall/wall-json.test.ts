import { describe, expect, test } from "bun:test";
import { wallJson } from "./wall-json";

describe("wallJson", () => {
  test("returns an ok body", async () => {
    expect(await wallJson<{ orders: [] }>(Response.json({ orders: [] }))).toEqual({ orders: [] });
  });

  test("rejects with the server's message", async () => {
    for (const status of [404, 503]) {
      const failure = Response.json({ error: "no order order-absent" }, { status });
      await expect(wallJson(failure)).rejects.toThrow(new Error("no order order-absent"));
    }
  });
});

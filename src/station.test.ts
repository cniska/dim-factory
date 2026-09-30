import { describe, expect, test } from "bun:test";
import { modelOf } from "./station";

describe("a station worker's model", () => {
  test("is the one named for its role, else the default, else none", () => {
    const models = { default: "sonnet", planner: "opus" };
    expect(modelOf(models, "planner")).toBe("opus");
    expect(modelOf(models, "builder")).toBe("sonnet");
    expect(modelOf({ planner: "opus" }, "builder")).toBeNull();
    expect(modelOf(undefined, "builder")).toBeNull();
  });
});

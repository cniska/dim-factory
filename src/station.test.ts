import { describe, expect, test } from "bun:test";
import { modelOf } from "./station";
import { Models } from "./station-contract";

describe("a station worker's model", () => {
  test("is the one named for its role, else the default, else none", () => {
    const models = { default: "sonnet", planner: "opus" };
    expect(modelOf(models, "planner")).toBe("opus");
    expect(modelOf(models, "builder")).toBe("sonnet");
    expect(modelOf({ planner: "opus" }, "builder")).toBeNull();
  });

  test("is named in a file that names nothing but the default and the station roles", () => {
    expect(Models.safeParse({ default: "sonnet", reviewer: "opus" }).success).toBe(true);
    expect(Models.safeParse({ operator: "opus" }).success).toBe(false);
    expect(Models.safeParse({ claude: { deep: "opus" } }).success).toBe(false);
  });
});

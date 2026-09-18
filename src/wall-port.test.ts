import { describe, expect, test } from "bun:test";
import { DEFAULT_WALL_PORT, WallPortError, wallPort } from "./wall-port";

describe("wallPort", () => {
  test("serves on one address when nothing is set, so a link keeps working", () => {
    expect(wallPort({})).toBe(DEFAULT_WALL_PORT);
    expect(wallPort({ DIM_WALL_PORT: "" })).toBe(DEFAULT_WALL_PORT);
  });

  test("takes the port the environment names", () => {
    expect(wallPort({ DIM_WALL_PORT: "8123" })).toBe(8123);
  });

  test("keeps 0 as the way to ask for any free port", () => {
    expect(wallPort({ DIM_WALL_PORT: "0" })).toBe(0);
  });

  test("refuses a value that is not a port rather than serving somewhere else", () => {
    for (const given of ["abc", "-1", "70000", "80.5"]) {
      expect(() => wallPort({ DIM_WALL_PORT: given })).toThrow(WallPortError);
    }
  });

  test("names the kind, so a caller branches on it rather than on the message", () => {
    try {
      wallPort({ DIM_WALL_PORT: "abc" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as WallPortError).kind).toBe("not-a-port");
    }
  });
});

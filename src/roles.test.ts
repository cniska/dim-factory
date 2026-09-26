import { describe, expect, test } from "bun:test";
import { isReadOnly, isRole, ROLES, ROLES_SQL } from "./roles";

describe("roles", () => {
  test("the planner and the reviewer may not touch the tree", () => {
    expect(isReadOnly("planner")).toBe(true);
    expect(isReadOnly("reviewer")).toBe(true);
  });

  test("the operator and the builder may", () => {
    expect(isReadOnly("operator")).toBe(false);
    expect(isReadOnly("builder")).toBe(false);
  });

  test("a word outside the vocabulary is no role", () => {
    expect(isRole("builder")).toBe(true);
    expect(isRole("checker")).toBe(false);
    expect(isRole("")).toBe(false);
  });

  test("the schema check names every role and nothing else", () => {
    expect(ROLES_SQL).toBe("'operator','planner','builder','reviewer'");
    expect(ROLES).toHaveLength(4);
  });
});

import { describe, expect, test } from "bun:test";
import { repositoryLabel } from "./git-remote";

describe("repositoryLabel", () => {
  test("names the same repository however it is addressed", () => {
    const expected = "cniska/acolyte";
    // A repository keeps its identity across forges and address forms, which is
    // the whole point: a worktree and its parent must land on one name.
    expect(repositoryLabel("git@github.com:cniska/acolyte.git")).toBe(expected);
    expect(repositoryLabel("https://github.com/cniska/acolyte.git")).toBe(expected);
    expect(repositoryLabel("https://github.com/cniska/acolyte")).toBe(expected);
    expect(repositoryLabel("ssh://git@github.com:22/cniska/acolyte.git")).toBe(expected);
    expect(repositoryLabel("https://gitlab.com/cniska/acolyte.git")).toBe(expected);
  });

  test("keeps nested owners rather than truncating to two segments", () => {
    expect(repositoryLabel("https://gitlab.com/group/sub/thing.git")).toBe("group/sub/thing");
  });

  test("lowercases, so one repository is not two", () => {
    expect(repositoryLabel("git@github.com:Cniska/Acolyte.git")).toBe("cniska/acolyte");
  });

  test("returns null for an address that names no shared repository", () => {
    // A path is a directory on one machine; treating it as an identity would
    // merge unrelated repositories that happen to sit at the same path.
    expect(repositoryLabel("/Users/x/code/acolyte")).toBeNull();
    expect(repositoryLabel("../sibling")).toBeNull();
    expect(repositoryLabel("C:/code/acolyte")).toBeNull();
    expect(repositoryLabel("github.com/onlyowner")).toBeNull();
  });
});

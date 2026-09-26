import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelFor, repositoryLabel } from "./git-remote";

describe("repositoryLabel", () => {
  test("names the same repository however it is addressed", () => {
    const expected = "cniska/acolyte";
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
    expect(repositoryLabel("/Users/x/code/acolyte")).toBeNull();
    expect(repositoryLabel("../sibling")).toBeNull();
    expect(repositoryLabel("C:/code/acolyte")).toBeNull();
    expect(repositoryLabel("github.com/onlyowner")).toBeNull();
  });

  test("ignores a checkout path that no longer exists", () => {
    expect(labelFor(join(tmpdir(), `missing-checkout-${crypto.randomUUID()}`))).toBeNull();
  });
});

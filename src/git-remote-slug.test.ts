import { describe, expect, test } from "bun:test";
import { isHostQualified, remoteSlug } from "./git-remote-slug";

const URLS: [string, string | null][] = [
  ["https://github.com/cniska/dim-factory.git", "github.com/cniska"],
  ["git@github.com:cniska/dim-factory.git", "github.com/cniska"],
  ["ssh://git@github.com/cniska/dim-factory.git", "github.com/cniska"],
  ["https://github.com/cniska/dim-factory", "github.com/cniska"],
  ["ssh://git@github.com:22/cniska/dim-factory.git", "github.com/cniska"],
  ["ssh://git@github.com:2222/cniska/dim-factory.git", "github.com/cniska"],
  ["https://GitHub.com/CNiska/dim-factory.git", "github.com/cniska"],
  ["GIT@GITHUB.COM:CNISKA/dim-factory.git", "github.com/cniska"],
  ["https://GÜNTHER.example.com/cniska/x.git", "gÜnther.example.com/cniska"],
  ["git@github.com:1234/dim-factory.git", "github.com/1234"],
  ["github.com:cniska/dim-factory.git", "github.com/cniska"],
  ["git@github.com:/cniska/dim-factory.git", "github.com/cniska"],
  ["file:///tmp/holding/cniska/evil.git", "/tmp/holding/cniska"],
  ["https://gitlab.com/cniska/evil.git", "gitlab.com/cniska"],
  ["git@evil.example.com:cniska/evil.git", "evil.example.com/cniska"],
  ["/tmp/holding/cniska/evil.git", "/tmp/holding/cniska"],
  ["https://github.com/org/cniska/evil.git", "github.com/org/cniska"],
  ["  https://github.com/cniska/x.git", "  https/github.com/cniska"],
  ["thing.git", null],
  ["", null],
];

describe("remoteSlug", () => {
  for (const [url, slug] of URLS) {
    test(`${url || "(empty)"} is ${slug ?? "nobody"}`, () => {
      expect(remoteSlug(url)).toBe(slug);
    });
  }
});

describe("isHostQualified", () => {
  test("a bare account name identifies nobody", () => {
    expect(isHostQualified("cniska")).toBe(false);
  });

  test("a host and an account together do", () => {
    expect(isHostQualified("github.com/cniska")).toBe(true);
  });

  test("an absolute path does", () => {
    expect(isHostQualified("/tmp/holding/cniska")).toBe(true);
  });

  test("a local path with spaces still identifies an owner", () => {
    expect(isHostQualified("/tmp/Chris Niska/project")).toBe(true);
  });

  test("control characters do not identify an owner", () => {
    expect(isHostQualified("github.com/x\nexit 0")).toBe(false);
  });

  test("a forge named without an account arms nothing", () => {
    expect(remoteSlug("https://github.com/x.git")).toBe("github.com");
    expect(isHostQualified("github.com")).toBe(false);
  });
});

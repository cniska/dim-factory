import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { isHostQualified, remoteSlug, SLUG_SED } from "./remote-slug";

/**
 * The gate arms on what this returns, so the table is the security boundary:
 * every row that is not `github.com/cniska` is a URL an attacker can choose.
 */
const URLS: [string, string | null][] = [
  ["https://github.com/cniska/dim-factory.git", "github.com/cniska"],
  ["git@github.com:cniska/dim-factory.git", "github.com/cniska"],
  ["ssh://git@github.com/cniska/dim-factory.git", "github.com/cniska"],
  ["https://github.com/cniska/dim-factory", "github.com/cniska"],
  // A non-default ssh port is a form a real remote takes, and the rule that
  // drops it is the one nothing else in this table would catch.
  ["ssh://git@github.com:22/cniska/dim-factory.git", "github.com/cniska"],
  ["ssh://git@github.com:2222/cniska/dim-factory.git", "github.com/cniska"],
  // Another forge, the same account name. Anyone may register `cniska` here.
  ["https://gitlab.com/cniska/evil.git", "gitlab.com/cniska"],
  ["git@evil.example.com:cniska/evil.git", "evil.example.com/cniska"],
  // A path segment that merely reads like an owner.
  ["/tmp/holding/cniska/evil.git", "/tmp/holding/cniska"],
  ["https://github.com/org/cniska/evil.git", "github.com/org/cniska"],
  // Nothing before the repository to identify anyone by.
  // Whitespace is not trimmed, by either. It fails closed and both agree it does.
  ["  https://github.com/cniska/x.git", "  https///github.com/cniska"],
  ["thing.git", null],
  ["", null],
];

describe("remoteSlug", () => {
  for (const [url, slug] of URLS) {
    test(`${url || "(empty)"} is ${slug ?? "nobody"}`, () => {
      expect(remoteSlug(url)).toBe(slug);
    });
  }

  // The bash hook is the boundary; this function only suggests owners. They
  // agree or the suggestion names something the hook will never match.
  test("the sed in the hook agrees with it on every row", () => {
    for (const [url, slug] of URLS) {
      const out = execFileSync("bash", ["-c", `printf '%s' "$1" | sed -nE '${SLUG_SED}'`, "_", url], {
        encoding: "utf8",
      });
      expect(out.replace(/\n$/, "")).toBe(slug ?? "");
    }
  });
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
});

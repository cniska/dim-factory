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
  // A host is case-insensitive by DNS and a forge account by registration, so
  // the same clone spelled either way is the same owner.
  ["https://GitHub.com/CNiska/dim-factory.git", "github.com/cniska"],
  ["GIT@GITHUB.COM:CNISKA/dim-factory.git", "github.com/cniska"],
  // Only ASCII is folded, because the sed maps A-Z and nothing else.
  ["https://GÜNTHER.example.com/cniska/x.git", "gÜnther.example.com/cniska"],
  // Without a scheme the colon is a path separator, never a port, and an
  // account may be all digits.
  ["git@github.com:1234/dim-factory.git", "github.com/1234"],
  ["github.com:cniska/dim-factory.git", "github.com/cniska"],
  ["git@github.com:/cniska/dim-factory.git", "github.com/cniska"],
  // No host between the scheme and the path.
  ["file:///tmp/holding/cniska/evil.git", "/tmp/holding/cniska"],
  // Another forge, the same account name. Anyone may register `cniska` here.
  ["https://gitlab.com/cniska/evil.git", "gitlab.com/cniska"],
  ["git@evil.example.com:cniska/evil.git", "evil.example.com/cniska"],
  // A path segment that merely reads like an owner.
  ["/tmp/holding/cniska/evil.git", "/tmp/holding/cniska"],
  ["https://github.com/org/cniska/evil.git", "github.com/org/cniska"],
  // Nothing before the repository to identify anyone by.
  // Whitespace is not trimmed, by either. It fails closed and both agree it does.
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

  // A URL with nothing between the host and the repository leaves the bare host
  // as the slug, and the owner list cannot hold one, so a clone from a forge the
  // owner uses cannot arm the gate by naming that forge alone.
  test("a forge named without an account arms nothing", () => {
    expect(remoteSlug("https://github.com/x.git")).toBe("github.com");
    expect(isHostQualified("github.com")).toBe(false);
  });
});

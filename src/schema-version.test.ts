import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

// Two branches that each bump the version make the same one-line edit, which git merges without a
// word while the schemas they stand for differ. Pinning the schema's digest on the version's line
// makes every schema edit touch that line, so a second branch changing the schema conflicts here.
// After changing the schema, set the digest to the one this test prints, and bump the version when
// the change is one `src/schema.ts` says needs it.
const PINNED = "59 862fbf2ba1f0c2e5d14b364ab28b7a2018c2a0d0eef93112553e44674bba461e";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

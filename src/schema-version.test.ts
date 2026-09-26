import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

const PINNED = "62 3f14caf1a7d6f0b68994c5b974edf415bf0becbe172b1f14ff96b005b4f63304";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

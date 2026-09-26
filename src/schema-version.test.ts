import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

const PINNED = "64 e58c5884c179c225af4555a79966e804c78267efcdd134b46449f9a7b624de8a";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

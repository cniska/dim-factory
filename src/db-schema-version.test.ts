import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

const PINNED = "67 71de6732a0f6619d1a8b1b84837c0308f173a5d2b869708dcaf9a2a89869f8b5";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

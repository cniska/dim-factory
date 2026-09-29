import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

const PINNED = "85 f76debba7cdc803f4689ddbf0dbef44e3579de9269365207a1d30cd83d54f4ca";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

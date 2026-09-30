import { expect, test } from "bun:test";
import { SCHEMA_VERSION } from "./db-schema";
import { FACTORY_SQL } from "./factory-db";

const PINNED = "89 a4a44ac09aa54aa368a4a4830cff84e234ae4a3a9c36dfc4c9d25039b0dab0e3";

test("the factory's tables are pinned together with the record's version", () => {
  const digest = new Bun.CryptoHasher("sha256").update(FACTORY_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

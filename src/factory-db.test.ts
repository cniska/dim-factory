import { expect, test } from "bun:test";
import { SCHEMA_VERSION } from "./db-schema";
import { FACTORY_SQL } from "./factory-db";

const PINNED = "89 b9f5af570a58577cd26e6fad49b31b6d319bfc81ed2beb535a809672f04e52a9";

test("the factory's tables are pinned together with the record's version", () => {
  const digest = new Bun.CryptoHasher("sha256").update(FACTORY_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

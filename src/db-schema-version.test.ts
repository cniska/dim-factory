import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

const PINNED = "74 80e641af209aa11b684c084473994244a0da3c80b91f915da3acdcd48c4c71f8";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

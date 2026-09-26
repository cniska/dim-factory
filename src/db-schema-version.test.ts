import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

const PINNED = "69 1657122057a7dc384c99d7221a2f637aca4485b000ef8bed5dffe8c452e0738f";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

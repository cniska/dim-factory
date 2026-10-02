import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

const PINNED = "91 f76a1f60aeae0ed4ff5c674066b5b9d134135fcff9b636bc26f056fbefaf9c4f";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

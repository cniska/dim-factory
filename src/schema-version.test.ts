import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

const PINNED = "61 5e6268ead65f92d31527741d035baa330ee2a0ce69c4114f30e2b8f556d61e16";

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

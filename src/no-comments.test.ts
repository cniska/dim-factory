import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { purgeCheckout } from "./comments-purge";

test("the code carries no comments beyond tool directives", () => {
  const report = purgeCheckout(resolve(import.meta.dir, ".."), { write: false });

  expect(report).toEqual({ files: [], unparsed: [] });
});

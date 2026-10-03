import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const RESOLVES_TO_DOCTOR = /resolve:[^\n]*"dim doctor"/;

test("no refusal names dim doctor as what resolves it, since a raised error already knows its problem", () => {
  const sources = [...new Glob("**/*.ts").scanSync(import.meta.dir)].filter(
    (file) => !file.endsWith(".test.ts"),
  );
  expect(sources.length).toBeGreaterThan(0);
  const naming = sources.filter((file) =>
    RESOLVES_TO_DOCTOR.test(readFileSync(join(import.meta.dir, file), "utf8")),
  );
  expect(naming).toEqual([]);
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const IMPORT = /from\s+"([^"]+)"/g;

test("the eval tool imports nothing from the factory's code", () => {
  const reaching = [...new Glob("**/*.ts").scanSync(import.meta.dir)].flatMap((file) =>
    [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(IMPORT)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier.includes("/src/") || specifier.startsWith("../src"))
      .map((specifier) => `${file} imports ${specifier}`),
  );
  expect(reaching).toEqual([]);
});

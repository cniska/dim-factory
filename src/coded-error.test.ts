import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = import.meta.dir;

const BUILDS_THE_BASE = "coded-error.ts";

const FILLS_ITS_RESOLVE_WHEN_PRINTED = "cli-contract.ts";

const BUILT_IN = "(?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error";

export function errorBreaches(file: string, text: string): readonly string[] {
  const breaches: string[] = [];
  if (new RegExp(`\\bnew ${BUILT_IN}\\(`).test(text)) breaches.push(`${file} throws an error with no code`);
  if (new RegExp(`\\bextends ${BUILT_IN}\\b`).test(text) && file !== BUILDS_THE_BASE) {
    breaches.push(`${file} declares its own error class`);
  }
  if (/\bnew CodedError\(/.test(text) && file !== BUILDS_THE_BASE) {
    breaches.push(`${file} builds a refusal outside a refusal table`);
  }
  if (/\bextends CodedError\b/.test(text) && file !== FILLS_ITS_RESOLVE_WHEN_PRINTED) {
    breaches.push(`${file} declares its own refusal class`);
  }
  return breaches;
}

function production(): readonly { readonly file: string; readonly text: string }[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
    .filter((file) => !/\.test\.tsx?$|test-support/.test(file))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

describe("every error", () => {
  test("is a refusal from its module's refusal table, or an assertion's", () => {
    expect(production().flatMap(({ file, text }) => errorBreaches(file, text))).toEqual([]);
  });
});

describe("the error check", () => {
  test("catches an error with no code, an error class and a refusal built by hand", () => {
    expect(errorBreaches("order-ops.ts", 'throw new Error("x")')).toEqual([
      "order-ops.ts throws an error with no code",
    ]);
    expect(errorBreaches("order-ops.ts", 'throw new TypeError("x")')).toEqual([
      "order-ops.ts throws an error with no code",
    ]);
    expect(errorBreaches("order-ops.ts", "class Gone extends Error {}")).toEqual([
      "order-ops.ts declares its own error class",
    ]);
    expect(errorBreaches("order-ops.ts", 'throw new CodedError("x")')).toEqual([
      "order-ops.ts builds a refusal outside a refusal table",
    ]);
    expect(errorBreaches("db.ts", "class Held extends CodedError {}")).toEqual([
      "db.ts declares its own refusal class",
    ]);
  });

  test("lets the base and the one class whose resolve the printer fills through", () => {
    expect(
      errorBreaches("coded-error.ts", "class CodedError extends Error { x = new CodedError(a) }"),
    ).toEqual([]);
    expect(errorBreaches("cli-contract.ts", "class UsageError extends CodedError {}")).toEqual([]);
  });
});

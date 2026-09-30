import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = import.meta.dir;

const FACTORY_MODULES = ["order", "worker", "station", "harness", "workspace", "check"];

const COMMAND_IMPORTS = /^\.\/([a-z-]+-(ops|contract)|cli-[a-z-]+|db|factory-db)$/;

const transpiler = new Bun.Transpiler({ loader: "ts" });

function sources(pattern: string): readonly { readonly file: string; readonly text: string }[] {
  return [...new Glob(pattern).scanSync(SRC)]
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

const moduleFiles = () =>
  FACTORY_MODULES.flatMap((name) => [...sources(`${name}.ts`), ...sources(`${name}-*.ts`)]);

const factoryCommands = () =>
  [...FACTORY_MODULES, "operator", "plan", "session"].flatMap((name) => sources(`${name}-command.ts`));

export function commandBreaches(file: string, text: string): readonly string[] {
  return transpiler
    .scanImports(text)
    .map((imported) => imported.path)
    .filter((path) => path.startsWith("./") && !COMMAND_IMPORTS.test(path))
    .map((path) => `${file} imports ${path}`);
}

export function sqlBreaches(file: string, text: string): readonly string[] {
  return !file.endsWith("-store.ts") && /\.(query|prepare)\(|\bdb\.run\(/.test(text)
    ? [`${file} runs SQL`]
    : [];
}

export function throwBreaches(file: string, text: string): readonly string[] {
  return /new CodedError\(|new Error\(/.test(text) ? [`${file} builds its own error`] : [];
}

describe("the factory's modules", () => {
  test("a factory command imports only ops, contracts and the CLI's own files", () => {
    expect(factoryCommands().flatMap(({ file, text }) => commandBreaches(file, text))).toEqual([]);
  });

  test("only a module's store runs SQL", () => {
    expect(moduleFiles().flatMap(({ file, text }) => sqlBreaches(file, text))).toEqual([]);
  });

  test("a refusal comes from its module's refusal table, and any other fault from an assertion", () => {
    expect(moduleFiles().flatMap(({ file, text }) => throwBreaches(file, text))).toEqual([]);
  });
});

describe("the module checks", () => {
  test("read every factory module and command", () => {
    const read = new Set(moduleFiles().map(({ file }) => file.replace(/(-[a-z]+)?\.ts$/, "")));
    expect([...read].sort()).toEqual([...FACTORY_MODULES].sort());
    expect(
      factoryCommands()
        .map(({ file }) => file)
        .sort(),
    ).toEqual(["operator-command.ts", "order-command.ts", "plan-command.ts", "session-command.ts"]);
  });

  test("catch a command importing a store, rules or effects", () => {
    const text =
      'import { a } from "./order-store";\nimport { b } from "./order";\nimport { c } from "./order-ops";\n';
    expect(commandBreaches("order-command.ts", `${text}export const x = [a, b, c];\n`)).toEqual([
      "order-command.ts imports ./order-store",
      "order-command.ts imports ./order",
    ]);
  });

  test("catch SQL outside a store", () => {
    expect(sqlBreaches("order-ops.ts", 'db.query("SELECT 1")')).toEqual(["order-ops.ts runs SQL"]);
    expect(sqlBreaches("order-store.ts", 'db.query("SELECT 1")')).toEqual([]);
  });

  test("catch an error built by hand", () => {
    expect(throwBreaches("order-ops.ts", 'throw new Error("x")')).toEqual([
      "order-ops.ts builds its own error",
    ]);
    expect(throwBreaches("order-ops.ts", 'throw new CodedError("x")')).toEqual([
      "order-ops.ts builds its own error",
    ]);
  });
});

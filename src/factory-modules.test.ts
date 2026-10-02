import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = import.meta.dir;

const FACTORY_MODULES = [
  "order",
  "worker",
  "station",
  "harness",
  "workspace",
  "check",
  "slice",
  "ship",
  "trace",
];

const COMMAND_IMPORTS = /^\.\/([a-z-]+-(ops|contract)|cli-[a-z-]+|db|db-read|factory-db|paths)$/;

const transpiler = new Bun.Transpiler({ loader: "ts" });

const TYPE_IMPORT = /^import\s+type\s[^;]*?from\s+"([^"]+)"/gm;

function importsOf(text: string): readonly string[] {
  const code = text.replace(/^#!.*\n/, "");
  const typeOnly = [...code.matchAll(TYPE_IMPORT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  return [...new Set([...transpiler.scanImports(code).map((imported) => imported.path), ...typeOnly])];
}

function sources(pattern: string): readonly { readonly file: string; readonly text: string }[] {
  return [...new Glob(pattern).scanSync(SRC)]
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

const moduleFiles = () =>
  FACTORY_MODULES.flatMap((name) => [...sources(`${name}.ts`), ...sources(`${name}-*.ts`)]);

const factoryCommands = () =>
  [...FACTORY_MODULES, "plan", "session", "finding", "build", "review"].flatMap((name) =>
    sources(`${name}-command.ts`),
  );

export function commandBreaches(file: string, text: string): readonly string[] {
  return importsOf(text)
    .filter((path) => path.startsWith("./") && !COMMAND_IMPORTS.test(path))
    .map((path) => `${file} imports ${path}`);
}

const PRIVATE_FILE = /^\.\/([a-z]+)-(store|effects)$/;

const DDL_JOIN = "factory-db.ts";

export function boundaryBreaches(file: string, text: string): readonly string[] {
  const importer = file.split("-")[0]?.replace(/\.tsx?$/, "");
  return importsOf(text)
    .filter((path) => {
      const owner = PRIVATE_FILE.exec(path);
      if (owner === null || owner[1] === importer) return false;
      return !(file === DDL_JOIN && owner[2] === "store");
    })
    .map((path) => `${file} imports ${path}, another module's own file`);
}

export function sqlBreaches(file: string, text: string): readonly string[] {
  return !file.endsWith("-store.ts") && /\.(query|prepare)\(|\bdb\.run\(/.test(text)
    ? [`${file} runs SQL`]
    : [];
}

describe("the factory's modules", () => {
  test("a module's store and effects are imported only by that module", () => {
    expect(sources("*.ts").flatMap(({ file, text }) => boundaryBreaches(file, text))).toEqual([]);
  });

  test("a factory command imports only ops, contracts and the CLI's own files", () => {
    expect(factoryCommands().flatMap(({ file, text }) => commandBreaches(file, text))).toEqual([]);
  });

  test("only a module's store runs SQL", () => {
    expect(moduleFiles().flatMap(({ file, text }) => sqlBreaches(file, text))).toEqual([]);
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
    ).toEqual([
      "build-command.ts",
      "finding-command.ts",
      "order-command.ts",
      "plan-command.ts",
      "review-command.ts",
      "session-command.ts",
      "slice-command.ts",
      "trace-command.ts",
    ]);
  });

  test("catch a command importing a store, rules or effects", () => {
    const text =
      'import { a } from "./order-store";\nimport { b } from "./order";\nimport { c } from "./order-ops";\n';
    expect(commandBreaches("order-command.ts", `${text}export const x = [a, b, c];\n`)).toEqual([
      "order-command.ts imports ./order-store",
      "order-command.ts imports ./order",
    ]);
  });

  test("catch a type-only import as well as a value import", () => {
    expect(commandBreaches("order-command.ts", 'import type { OrderView } from "./order-view";\n')).toEqual([
      "order-command.ts imports ./order-view",
    ]);
  });

  test("catch an import of another module's store or effects, but not of its own", () => {
    const text = 'import { a } from "./worker-store";\nimport { b } from "./order-store";\n';
    expect(boundaryBreaches("order-ops.ts", text)).toEqual([
      "order-ops.ts imports ./worker-store, another module's own file",
    ]);
    expect(boundaryBreaches("factory-db.ts", text)).toEqual([]);
    expect(boundaryBreaches("factory-db.ts", 'import { c } from "./worker-effects";\n')).toEqual([
      "factory-db.ts imports ./worker-effects, another module's own file",
    ]);
  });

  test("catch SQL outside a store", () => {
    expect(sqlBreaches("order-ops.ts", 'db.query("SELECT 1")')).toEqual(["order-ops.ts runs SQL"]);
    expect(sqlBreaches("order-store.ts", 'db.query("SELECT 1")')).toEqual([]);
  });
});

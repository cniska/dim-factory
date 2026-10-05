import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Node } from "@babel/types";
import { Glob } from "bun";
import { importsOf, nodesOf } from "./syntax.test-support";

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

const COMMAND_IMPORTS = /^\.\/([a-z-]+-(ops|contract)|cli-[a-z-]+|db|db-read|paths)$/;

function sources(pattern: string): readonly { readonly file: string; readonly text: string }[] {
  return withTests(pattern).filter(({ file }) => !file.endsWith(".test.ts"));
}

function withTests(pattern: string): readonly { readonly file: string; readonly text: string }[] {
  return [...new Glob(pattern).scanSync(SRC)].map((file) => ({
    file,
    text: readFileSync(join(SRC, file), "utf8"),
  }));
}

const moduleFiles = () =>
  FACTORY_MODULES.flatMap((name) => [...sources(`${name}.ts`), ...sources(`${name}-*.ts`)]);

const factoryCommands = () =>
  [...FACTORY_MODULES, "plan", "session", "finding", "build", "review"].flatMap((name) =>
    sources(`${name}-command.ts`),
  );

export function commandBreaches(file: string, text: string): readonly string[] {
  return importsOf(file, text)
    .filter((path) => path.startsWith("./") && !COMMAND_IMPORTS.test(path))
    .map((path) => `${file} imports ${path}`);
}

const MODULE_FILE = /^\.\.?\/([a-z]+)-([a-z-]+)$/;

const PUBLIC_PARTS = new Set(["ops", "contract", "command"]);

function isInternal(owner: string, part: string): boolean {
  if (part === "store" || part === "effects") return true;
  return FACTORY_MODULES.includes(owner) && !PUBLIC_PARTS.has(part);
}

export function boundaryBreaches(file: string, text: string): readonly string[] {
  const importer = basename(file).split(/[-.]/)[0];
  return importsOf(file, text)
    .filter((path) => {
      const named = MODULE_FILE.exec(path);
      if (named === null) return false;
      const [, owner = "", part = ""] = named;
      return owner !== importer && isInternal(owner, part);
    })
    .map((path) => `${file} imports ${path}, another module's own file`);
}

function runsSql(node: Node): boolean {
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return false;
  if (callee.property.type !== "Identifier") return false;
  const method = callee.property.name;
  if (method === "query" || method === "prepare") return true;
  const owner = callee.object;
  const isDb =
    (owner.type === "Identifier" && owner.name === "db") ||
    ((owner.type === "MemberExpression" || owner.type === "OptionalMemberExpression") &&
      ((owner.property.type === "Identifier" && owner.property.name === "db") ||
        (owner.property.type === "PrivateName" && owner.property.id.name === "db")));
  return method === "run" && isDb;
}

export function sqlBreaches(file: string, text: string): readonly string[] {
  if (file.endsWith("-store.ts")) return [];
  return [...nodesOf(file, text)].some(runsSql) ? [`${file} runs SQL`] : [];
}

describe("the factory's modules", () => {
  test("another module or its tests reach a factory module only through its public files; only a test fixture seeds a store", () => {
    const checked = withTests("**/*.{ts,tsx}").filter(({ file }) => !file.endsWith(".test-support.ts"));
    expect(checked.flatMap(({ file, text }) => boundaryBreaches(file, text))).toEqual([]);
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

  test("catch an import however it is written", () => {
    const view = "order-command.ts imports ./order-view";
    for (const text of [
      'import { type OrderView } from "./order-view";',
      'export type { OrderView } from "./order-view";',
      'export * from "./order-view";',
      '  import type { OrderView } from "./order-view";',
      'import type {\n  OrderView,\n} from\n  "./order-view";',
      'const view = await import("./order-view");',
      "const view = await import(`./order-view`);",
      'const view = require("./order-view");',
      'let x: import("./order-view").OrderView;',
      'import view = require("./order-view");',
    ]) {
      expect(commandBreaches("order-command.ts", text)).toEqual([view]);
    }
  });

  test("catch an import of another module's store or effects, but not of its own", () => {
    const text = 'import { a } from "./worker-store";\nimport { b } from "./order-store";\n';
    expect(boundaryBreaches("order-ops.ts", text)).toEqual([
      "order-ops.ts imports ./worker-store, another module's own file",
    ]);
  });

  test("catch an import of a factory module's internal part, but not of its ops, contract or rules", () => {
    const text =
      'import { a } from "./harness-claude";\nimport { b } from "./harness-ops";\n' +
      'import { c } from "./harness-contract";\nimport { d } from "./order";\nimport { e } from "./config-jsonc";\n';
    expect(boundaryBreaches("station-ops.ts", text)).toEqual([
      "station-ops.ts imports ./harness-claude, another module's own file",
    ]);
  });

  test("catch SQL outside a store", () => {
    expect(sqlBreaches("order-ops.ts", 'db.query("SELECT 1")')).toEqual(["order-ops.ts runs SQL"]);
    expect(sqlBreaches("order-store.ts", 'db.query("SELECT 1")')).toEqual([]);
    for (const text of [
      'db?.query("x")',
      'this.db.run("x")',
      'class A { #db: any; f() { this.#db.run("x"); } }',
      'db.run("x")',
      'x.prepare("y")',
    ]) {
      expect(sqlBreaches("order-ops.ts", text)).toEqual(["order-ops.ts runs SQL"]);
    }
    expect(sqlBreaches("order-ops.ts", 'const help = "db.query(x)"')).toEqual([]);
  });
});

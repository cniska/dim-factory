import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { purgeCheckout, purgeText } from "./comments-purge";

const purged = (text: string, path = "a.ts") => purgeText(path, text)?.text;

describe("purging one file", () => {
  test("removes a comment on a line of its own, line and all", () => {
    expect(purged("const a = 1;\n// why\nconst b = 2;\n")).toBe("const a = 1;\nconst b = 2;\n");
  });

  test("removes a trailing comment and the space before it", () => {
    expect(purged("const a = 1; // why\n")).toBe("const a = 1;\n");
  });

  test("removes a block comment before code on its line, and the space after it", () => {
    expect(purged("/* why */ const a = 1;\n")).toBe("const a = 1;\n");
  });

  test("removes a docblock spanning several lines", () => {
    expect(purged("/**\n * Why.\n * And more.\n */\nexport const a = 1;\n")).toBe("export const a = 1;\n");
  });

  test("removes a comment on the last line with no newline after it", () => {
    expect(purged("const a = 1;\n// why")).toBe("const a = 1;\n");
  });

  test("removes a JSX comment together with the braces around it", () => {
    const before = "export const A = () => (\n  <div>\n    {/* why */}\n    <p />\n  </div>\n);\n";
    expect(purged(before, "a.tsx")).toBe("export const A = () => (\n  <div>\n    <p />\n  </div>\n);\n");
  });

  test("counts what it removed", () => {
    expect(purgeText("a.ts", "// one\nconst a = 1; // two\n/* three */\n")?.removed).toBe(3);
  });

  test("keeps tool contracts and the shebang", () => {
    const kept = [
      "#!/usr/bin/env bun",
      '/// <reference types="bun" />',
      "/*! license */",
      "// biome-ignore lint/style/noNonNullAssertion: checked",
      "// @ts-expect-error",
      "const a = /* #__PURE__ */ make();",
      "",
    ].join("\n");
    expect(purged(kept)).toBe(kept);
  });

  test("keeps JSDoc types in a JavaScript file, where they are the types", () => {
    const text = "/** @type {number} */\nconst a = 1;\n";
    expect(purged(text, "a.js")).toBe(text);
  });

  test("leaves comment markers inside strings, templates and regular expressions", () => {
    const text = 'const a = "// no";\nconst b = `/* no */`;\nconst c = /\\/\\/ no/;\n';
    expect(purged(text)).toBe(text);
  });

  test("answers nothing for a file it cannot parse", () => {
    expect(purgeText("a.ts", "const = ;")).toBeNull();
  });

  test("answers nothing for a file that parses only by recovering from an error", () => {
    expect(purgeText("a.ts", "// why\nlet a = 1;\nlet a = 2;\n")).toBeNull();
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-purge-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

describe("purging a checkout", () => {
  test("names what it would remove and writes nothing without write", () => {
    const dir = repo({ "a.ts": "// why\nconst a = 1;\n", "b.ts": "const b = 2;\n" });
    const report = purgeCheckout(dir, { write: false });
    expect(report.files).toEqual([{ path: "a.ts", removed: 1 }]);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("// why\nconst a = 1;\n");
  });

  test("rewrites each file with write", () => {
    const dir = repo({ "src/a.ts": "// why\nconst a = 1;\n" });
    purgeCheckout(dir, { write: true });
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
  });

  test("reads only tracked files, in the languages the gate judges", () => {
    const dir = repo({ "a.ts": "const a = 1;\n", "notes.md": "<!-- why -->\n", "run.sh": "# why\n" });
    writeFileSync(join(dir, "untracked.ts"), "// why\n");
    expect(purgeCheckout(dir, { write: false }).files).toEqual([]);
  });

  test("leaves a file git marks generated or vendored", () => {
    const dir = repo({
      ".gitattributes": "gen.ts linguist-generated\nvendor/** linguist-vendored\n",
      "gen.ts": "// why\n",
      "vendor/lib.ts": "// why\n",
    });
    expect(purgeCheckout(dir, { write: false }).files).toEqual([]);
  });

  test("limits itself to the paths it is given", () => {
    const dir = repo({ "src/a.ts": "// why\n", "test/b.ts": "// why\n" });
    expect(purgeCheckout(dir, { write: false, paths: ["src"] }).files).toEqual([
      { path: "src/a.ts", removed: 1 },
    ]);
  });

  test("names a file it cannot parse and leaves it as it is", () => {
    const dir = repo({ "bad.ts": "// why\nlet a = 1;\nlet a = 2;\n" });
    const report = purgeCheckout(dir, { write: true });
    expect(report.unparsed).toEqual(["bad.ts"]);
    expect(readFileSync(join(dir, "bad.ts"), "utf8")).toBe("// why\nlet a = 1;\nlet a = 2;\n");
  });
});

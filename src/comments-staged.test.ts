import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stagedComments } from "./comments-staged";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-comments-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "core.hooksPath", join(dir, "no-hooks")]);
  if (Object.keys(files).length > 0) {
    stage(dir, files);
    git(dir, ["commit", "-q", "-m", "feat: start"]);
  }
  return dir;
}

function stage(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ["add", "-A"]);
}

function added(files: Record<string, string>): { path: string; line: number }[] {
  const dir = repo();
  stage(dir, files);
  return stagedComments(dir).found;
}

describe("comments on added lines", () => {
  test("reports a comment on an added line as its path and line", () => {
    expect(added({ "a.ts": "const a = 1;\n// why\nconst b = 2;\n" })).toEqual([{ path: "a.ts", line: 2 }]);
  });

  test("reports a trailing comment and a block comment", () => {
    expect(added({ "a.ts": "const a = 1; // why\n/*\n  more\n*/\n" })).toEqual([
      { path: "a.ts", line: 1 },
      { path: "a.ts", line: 2 },
    ]);
  });

  test("counts lines the way git does in a file with CRLF endings", () => {
    expect(added({ "a.ts": "const a = 1;\r\nconst b = 2;\r\n// why\r\n" })).toEqual([
      { path: "a.ts", line: 3 },
    ]);
  });

  test("leaves an existing comment the change does not touch", () => {
    const dir = repo({ "a.ts": "// old\nconst a = 1;\n" });
    stage(dir, { "a.ts": "// old\nconst a = 1;\nconst b = 2;\n" });
    expect(stagedComments(dir).found).toEqual([]);
  });

  test("counts an edited line as added", () => {
    const dir = repo({ "a.ts": "const a = 1; // old\n" });
    stage(dir, { "a.ts": "const a = 2; // old\n" });
    expect(stagedComments(dir).found).toEqual([{ path: "a.ts", line: 1 }]);
  });

  test("counts a block comment where any line of it is added", () => {
    const dir = repo({ "a.ts": "/*\n  first\n*/\nconst a = 1;\n" });
    stage(dir, { "a.ts": "/*\n  second\n*/\nconst a = 1;\n" });
    expect(stagedComments(dir).found).toEqual([{ path: "a.ts", line: 2 }]);
  });

  test("leaves a renamed file's comments alone", () => {
    const dir = repo({ "a.ts": "// kept\nconst a = 1;\n" });
    git(dir, ["mv", "a.ts", "b.ts"]);
    expect(stagedComments(dir).found).toEqual([]);
  });

  test("judges a file rewritten past rename detection as new", () => {
    const dir = repo({ "a.ts": "// kept\nconst a = 1;\nconst b = 2;\nconst c = 3;\n" });
    git(dir, ["rm", "-q", "a.ts"]);
    stage(dir, { "b.ts": "// kept\nexport const x = 9;\nexport const y = 8;\nexport const z = 7;\n" });
    expect(stagedComments(dir).found).toEqual([{ path: "b.ts", line: 1 }]);
  });

  test("reads only what is staged, not the working tree", () => {
    const dir = repo({ "a.ts": "const a = 1;\n" });
    stage(dir, { "a.ts": "const a = 1;\nconst b = 2;\n" });
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n// unstaged\nconst b = 2;\n");
    expect(stagedComments(dir).found).toEqual([]);
  });

  test("names a path with a space in it as git does", () => {
    expect(added({ "some dir/a.ts": "// why\n" })).toEqual([{ path: "some dir/a.ts", line: 1 }]);
  });

  test("reads a bracketed path as that path, not as a pattern matching another", () => {
    const dir = repo({ "app/[slug]/page.tsx": "const a = 1;\n// old\nconst b = 2;\n" });
    stage(dir, {
      "app/[slug]/page.tsx": "const a = 3;\n// old\nconst b = 2;\n",
      "app/s/page.tsx": "const x = 1;\n// why\n",
    });
    expect(stagedComments(dir).found).toEqual([{ path: "app/s/page.tsx", line: 2 }]);
  });

  test("judges every JavaScript and TypeScript extension", () => {
    const exts = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
    const files = Object.fromEntries(exts.map((ext) => [`a.${ext}`, "// why\n"]));
    expect(added(files).map((c) => c.path)).toEqual(exts.map((ext) => `a.${ext}`).sort());
  });

  test("does not judge a file in another language", () => {
    expect(
      added({ "a.py": "# why\n", "a.css": "/* why */\n", "a.md": "// why\n", "a.sh": "# why\n" }),
    ).toEqual([]);
  });

  test("does not judge a file it cannot parse, and names it", () => {
    const dir = repo();
    stage(dir, { "a.ts": "const = ;\n// why\n", "b.ts": "// why\n" });
    expect(stagedComments(dir)).toEqual({ found: [{ path: "b.ts", line: 1 }], unparsed: ["a.ts"] });
  });

  test("does not judge a file git marks generated or vendored", () => {
    expect(
      added({
        ".gitattributes": "gen/** linguist-generated\nvendor/** linguist-vendored=true\n",
        "gen/a.ts": "// why\n",
        "vendor/b.js": "// why\n",
        "src/c.ts": "// why\n",
      }),
    ).toEqual([{ path: "src/c.ts", line: 1 }]);
  });
});

describe("tool contracts", () => {
  for (const contract of [
    "// biome-ignore lint/style/noNonNullAssertion: checked above",
    "// @ts-expect-error the fixture is malformed on purpose",
    "// @ts-ignore",
    "// @ts-nocheck",
    "/* @ts-self-types=./a.d.ts */",
    "// eslint-disable-next-line no-console",
    "/* eslint-disable */",
    "// eslint-disable-line",
    "// prettier-ignore",
    '/// <reference types="bun" />',
    "/*! a license header */",
    "const a = /* #__PURE__ */ f();",
    "const a = /*@__PURE__*/ f();",
  ]) {
    test(`exempts ${contract}`, () => {
      expect(added({ "a.ts": `const b = 1;\n${contract}\nconst c = 2;\n` })).toEqual([]);
    });
  }

  test("exempts a shebang", () => {
    expect(added({ "a.ts": "#!/usr/bin/env bun\nconst a = 1;\n" })).toEqual([]);
  });

  test("still reports an ordinary comment beside a contract", () => {
    expect(added({ "a.ts": "// @ts-nocheck\n// why\n" })).toEqual([{ path: "a.ts", line: 2 }]);
  });

  for (const ext of ["js", "mjs", "cjs"]) {
    test(`exempts JSDoc types in a .${ext} file`, () => {
      const text =
        "/** @type {number} */\nconst a = 1;\n/** @typedef {{ a: number }} Thing */\n/**\n * @param {string} x\n * @param {number} y\n */\nfunction f(x, y) {}\n";
      expect(added({ [`a.${ext}`]: text })).toEqual([]);
    });
  }

  test("reports JSDoc that says more than its parameter types", () => {
    const text = "/**\n * Adds.\n * @param {number} x\n */\nfunction f(x) {}\n";
    expect(added({ "a.js": text })).toEqual([{ path: "a.js", line: 1 }]);
  });

  test("reports JSDoc types in a TypeScript file, where the types are the code's", () => {
    expect(added({ "a.ts": "/** @type {number} */\nconst a = 1;\n" })).toEqual([{ path: "a.ts", line: 1 }]);
  });
});

describe("what is not a comment", () => {
  test("a comment marker inside a string", () => {
    expect(added({ "a.ts": "const a = \"// no\";\nconst b = '/* no */';\n" })).toEqual([]);
  });

  test("a comment marker inside a template literal", () => {
    const text = `const a = \`// no \${1} /* no */\`;\nconst b = \`\${\`// nested\`}\`;\nconst c = \`a\n// still text\n\`;\n`;
    expect(added({ "a.ts": text })).toEqual([]);
  });

  test("a comment inside a template substitution is one", () => {
    expect(added({ "a.ts": `const a = \`x \${/* why */ 1} y\`;\n` })).toEqual([{ path: "a.ts", line: 1 }]);
  });

  test("a regular expression that contains comment markers", () => {
    const text = 'const a = "x".replace(/\\/\\/ no/, "");\nconst b = [/\\/*/];\nif (a) /[/*]/.test(a);\n';
    expect(added({ "a.ts": text })).toEqual([]);
  });

  test("a division after a non-null assertion, before a real comment", () => {
    expect(added({ "a.ts": "const r = total! / count; // x\n" })).toEqual([{ path: "a.ts", line: 1 }]);
  });

  test("JSX text and attributes", () => {
    const text =
      'const a = <a href="https://example.com">see https://example.com // no</a>;\nconst b = <>/* no */</>;\n';
    expect(added({ "a.tsx": text })).toEqual([]);
  });

  test("JSX text inside a generic component", () => {
    expect(added({ "a.tsx": "const a = <Select<Opt>>see https://x // no</Select>;\n" })).toEqual([]);
  });

  test("a comment inside a JSX expression is one", () => {
    expect(added({ "a.tsx": "const a = <div>{/* why */}</div>;\n" })).toEqual([{ path: "a.tsx", line: 1 }]);
  });

  for (const [what, text] of [
    ["a decorated export", "export @dec class A {} // why\n"],
    ["a decorated auto-accessor", "class A { @dec accessor x = 1 } // why\n"],
    ["a legacy parameter decorator", "class A { constructor(@Inject() x) {} } // why\n"],
  ]) {
    test(`judges a comment beside ${what}`, () => {
      expect(added({ "a.ts": text as string })).toEqual([{ path: "a.ts", line: 1 }]);
    });
  }

  test("a generic arrow in a TSX file is code, not JSX", () => {
    expect(added({ "a.tsx": "const f = <T,>(x: T) => x; // why\n" })).toEqual([{ path: "a.tsx", line: 1 }]);
  });
});

describe("a merge", () => {
  function conflicted(): string {
    const dir = repo({ "a.ts": "const a = 1;\n" });
    const trunk = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
    git(dir, ["checkout", "-q", "-b", "side"]);
    stage(dir, { "a.ts": "// theirs\nconst a = 2;\n" });
    git(dir, ["commit", "-q", "-m", "feat: side"]);
    git(dir, ["checkout", "-q", trunk]);
    stage(dir, { "a.ts": "const a = 3;\n" });
    git(dir, ["commit", "-q", "-m", "feat: trunk"]);
    expect(spawnSync("git", ["-C", dir, "merge", "-q", "side"], { stdio: "pipe" }).status).not.toBe(0);
    return dir;
  }

  test("passes a resolution that keeps the other branch's comments", () => {
    const dir = conflicted();
    stage(dir, { "a.ts": "// theirs\nconst a = 4;\n" });
    expect(stagedComments(dir).found).toEqual([]);
  });

  test("passes the other branch's comments in a file our branch renamed", () => {
    const body = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n";
    const dir = repo({ "a.ts": body });
    const trunk = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
    git(dir, ["checkout", "-q", "-b", "side"]);
    stage(dir, { "a.ts": `// theirs\n${body.replace("const a = 1;", "const a = 2;")}` });
    git(dir, ["commit", "-q", "-m", "feat: side"]);
    git(dir, ["checkout", "-q", trunk]);
    git(dir, ["mv", "a.ts", "b.ts"]);
    stage(dir, { "b.ts": body.replace("const a = 1;", "const a = 3;") });
    git(dir, ["commit", "-q", "-m", "feat: trunk"]);
    expect(spawnSync("git", ["-C", dir, "merge", "-q", "side"], { stdio: "pipe" }).status).not.toBe(0);
    stage(dir, { "b.ts": `// theirs\n${body.replace("const a = 1;", "const a = 4;")}` });
    expect(stagedComments(dir).found).toEqual([]);
  });

  test("judges an octopus merge against every branch it brings in", () => {
    const dir = repo({ "base.ts": "const a = 1;\n" });
    const trunk = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
    for (const branch of ["one", "two"]) {
      git(dir, ["checkout", "-q", "-b", branch, trunk]);
      stage(dir, { [`${branch}.ts`]: `// from ${branch}\nconst x = 1;\n` });
      git(dir, ["commit", "-q", "-m", `feat: ${branch}`]);
    }
    git(dir, ["checkout", "-q", trunk]);
    git(dir, ["merge", "-q", "--no-commit", "one", "two"]);
    stage(dir, { "mine.ts": "// mine\n" });
    expect(stagedComments(dir).found).toEqual([{ path: "mine.ts", line: 1 }]);
  });

  test("refuses a comment the resolution itself adds", () => {
    const dir = conflicted();
    stage(dir, { "a.ts": "// theirs\n// mine\nconst a = 4;\n" });
    expect(stagedComments(dir).found).toEqual([{ path: "a.ts", line: 2 }]);
  });
});

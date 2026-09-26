import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectConfigPath, readConfig, userConfigPath, writeConfigValue } from "./config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-config-"));
  roots.push(dir);
  return dir;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function repo(project: string | null): string {
  const dir = scratch();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  if (project !== null) put(join(dir, ".dim", "config.json"), project);
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--no-verify", "-m", "feat: start"]);
  return dir;
}

describe("the layers a setting is read from", () => {
  test("is empty with neither layer written", () => {
    expect(readConfig({ env: { HOME: scratch() } })).toEqual({});
  });

  test("reads the user layer from the home config", () => {
    const home = scratch();
    put(join(home, ".config", "dim", "config.json"), '{ "comments": "banned" }');
    expect(userConfigPath({ HOME: home })).toBe(join(home, ".config", "dim", "config.json"));
    expect(readConfig({ env: { HOME: home } })).toEqual({ comments: "banned" });
  });

  test("lets the project layer override the user layer", () => {
    const home = scratch();
    put(join(home, ".config", "dim", "config.json"), '{ "comments": "banned" }');
    const root = repo('{ "comments": "allowed" }');
    expect(readConfig({ env: { HOME: home }, root, at: "HEAD" })).toEqual({ comments: "allowed" });
  });

  test("reads the project layer as a revision holds it, not as the working tree does", () => {
    const root = repo('{ "comments": "banned" }');
    writeFileSync(projectConfigPath(root), '{ "comments": "allowed" }');
    expect(readConfig({ env: { HOME: scratch() }, root, at: "HEAD" })).toEqual({ comments: "banned" });
    expect(readConfig({ env: { HOME: scratch() }, root })).toEqual({ comments: "allowed" });
  });

  test("reads no project layer at a revision that does not hold one", () => {
    const root = repo(null);
    expect(readConfig({ env: { HOME: scratch() }, root, at: "HEAD" })).toEqual({});
  });

  test("reads no project layer in a repository with no commit yet", () => {
    const root = scratch();
    execFileSync("git", ["init", "-q", root]);
    expect(readConfig({ env: { HOME: scratch() }, root, at: "HEAD" })).toEqual({});
  });

  test("reads a layer carrying comments of its own", () => {
    const home = scratch();
    put(join(home, ".config", "dim", "config.json"), '{\n  // mine\n  "comments": "banned",\n}\n');
    expect(readConfig({ env: { HOME: home } })).toEqual({ comments: "banned" });
  });

  for (const [what, text] of [
    ["a key no setting has", '{ "comment": "banned" }'],
    ["a value the key does not take", '{ "comments": "maybe" }'],
    ["a value of the wrong type", '{ "comments": true }'],
    ["a repeated key", '{ "comments": "banned", "comments": "allowed" }'],
    ["a layer that is not an object", '["comments"]'],
    ["a layer that does not parse", '{ "comments": '],
  ]) {
    test(`refuses ${what}, naming the file`, () => {
      const home = scratch();
      put(join(home, ".config", "dim", "config.json"), text as string);
      expect(() => readConfig({ env: { HOME: home } })).toThrow(join(home, ".config", "dim", "config.json"));
    });
  }
});

describe("writing a setting", () => {
  test("creates the layer when it is absent", () => {
    const path = join(scratch(), ".dim", "config.json");
    writeConfigValue(path, "comments", "banned");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ comments: "banned" });
  });

  test("keeps the comments and other lines already in the layer", () => {
    const path = join(scratch(), "config.json");
    put(path, '{\n  // mine\n  "comments": "allowed"\n}\n');
    writeConfigValue(path, "comments", "banned");
    expect(readFileSync(path, "utf8")).toBe('{\n  // mine\n  "comments": "banned"\n}\n');
  });

  test("removes a setting when given no value", () => {
    const path = join(scratch(), "config.json");
    put(path, '{ "comments": "banned" }\n');
    writeConfigValue(path, "comments", undefined);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  test("refuses a value the key does not take, writing nothing", () => {
    const path = join(scratch(), "config.json");
    expect(() => writeConfigValue(path, "comments", "maybe")).toThrow("banned, allowed");
    expect(() => readFileSync(path)).toThrow();
  });
});

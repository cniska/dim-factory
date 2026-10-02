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
    put(join(home, ".config", "dim", "config.json"), '{ "ship": "default-branch" }');
    expect(userConfigPath({ HOME: home })).toBe(join(home, ".config", "dim", "config.json"));
    expect(readConfig({ env: { HOME: home } })).toEqual({ ship: "default-branch" });
  });

  test("reads the model each role runs on from the user layer, beside the project's settings", () => {
    const home = scratch();
    put(
      join(home, ".config", "dim", "config.json"),
      '{ "models": { "default": "sonnet", "planner": "opus" } }',
    );
    const root = repo('{ "ship": "default-branch" }');
    expect(readConfig({ env: { HOME: home }, root, at: "HEAD" })).toEqual({
      ship: "default-branch",
      models: { default: "sonnet", planner: "opus" },
    });
  });

  test("refuses models that name no station role, and models in a project's layer", () => {
    const home = scratch();
    put(join(home, ".config", "dim", "config.json"), '{ "models": { "operator": "opus" } }');
    expect(() => readConfig({ env: { HOME: home } })).toThrow("models");
    const root = repo('{ "models": { "planner": "opus" } }');
    expect(() => readConfig({ env: { HOME: scratch() }, root, at: "HEAD" })).toThrow("models");
  });

  test("reads the project layer as a revision holds it, not as the working tree does", () => {
    const root = repo("{}");
    writeFileSync(projectConfigPath(root), '{ "ship": "default-branch" }');
    expect(readConfig({ env: { HOME: scratch() }, root, at: "HEAD" })).toEqual({});
    expect(readConfig({ env: { HOME: scratch() }, root })).toEqual({ ship: "default-branch" });
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
    put(join(home, ".config", "dim", "config.json"), '{\n  // mine\n  "ship": "default-branch",\n}\n');
    expect(readConfig({ env: { HOME: home } })).toEqual({ ship: "default-branch" });
  });

  for (const [what, text] of [
    ["a key no setting has", '{ "comments": "banned" }'],
    ["a value the key does not take", '{ "ship": "maybe" }'],
    ["a value of the wrong type", '{ "ship": true }'],
    ["a repeated key", '{ "ship": "default-branch", "ship": "default-branch" }'],
    ["a layer that is not an object", '["ship"]'],
    ["a layer that does not parse", '{ "ship": '],
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
    writeConfigValue(path, "ship", "default-branch");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ship: "default-branch" });
  });

  test("keeps the comments and other lines already in the layer", () => {
    const path = join(scratch(), "config.json");
    put(path, "{\n  // mine\n}\n");
    writeConfigValue(path, "ship", "default-branch");
    expect(readFileSync(path, "utf8")).toBe('{\n  "ship": "default-branch"\n  // mine\n}\n');
  });

  test("removes a setting when given no value", () => {
    const path = join(scratch(), "config.json");
    put(path, '{ "ship": "default-branch" }\n');
    writeConfigValue(path, "ship", undefined);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  test("refuses a value the key does not take, writing nothing", () => {
    const path = join(scratch(), "config.json");
    expect(() => writeConfigValue(path, "ship", "maybe")).toThrow("default-branch");
    expect(() => readFileSync(path)).toThrow();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceContract } from "./workspace";

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dim-workspace-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("workspace contract", () => {
  test("composes declared repository facts without inventing a check", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { format: "biome format", lint: "biome check" } }),
      "bun.lock": "",
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.checkoutRoot).toBe(root);
    expect(contract.packageManagers).toEqual(["bun"]);
    expect(contract.checkTask).toBeNull();
    expect(contract.formatTask?.command).toBe("bun run format");
    expect(contract.worktree.path).toBe(root);
    expect(contract.languages).toEqual(["javascript"]);
    expect(contract.ecosystems).toEqual(["node"]);
    expect(contract.members).toEqual([]);
    expect(contract.capabilities).toEqual({ format: true, analyze: false, test: false });
  });

  test("identifies a Flutter pub workspace and its declared capabilities", () => {
    const root = repo({
      "pubspec.yaml": [
        "name: hoodly",
        "workspace:",
        "  - apps/vendor",
        "  - packages/core",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
      ].join("\n"),
      "mise.toml": [
        "[tasks]",
        'analyze = "flutter analyze"',
        'test = "flutter test"',
        'format = "dart format"',
      ].join("\n"),
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.languages).toEqual(["dart"]);
    expect(contract.ecosystems).toEqual(["flutter"]);
    expect(contract.packageManagers).toEqual(["flutter"]);
    expect(contract.members.map((member) => member.path)).toEqual(["apps/vendor", "packages/core"]);
    expect(contract.bootstrap).toEqual({ command: ["flutter", "pub", "get"], source: "pubspec.yaml" });
    expect(contract.capabilities).toEqual({ format: true, analyze: true, test: true });
  });

  test("keeps an ordinary Dart package distinct from Flutter", () => {
    const root = repo({ "pubspec.yaml": "name: parser\ndependencies:\n  meta: ^1.0.0\n" });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.ecosystems).toEqual(["dart"]);
    expect(contract.packageManagers).toEqual(["dart"]);
    expect(contract.bootstrap).toEqual({ command: ["dart", "pub", "get"], source: "pubspec.yaml" });
    expect(contract.capabilities).toEqual({ format: false, analyze: false, test: false });
  });

  test("does not treat a later YAML list as workspace members", () => {
    const root = repo({
      "pubspec.yaml": "name: parser\nworkspace:\n  - packages/core\nother:\n  - unrelated\n",
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.members.map((member) => member.path)).toEqual(["packages/core"]);
  });
});

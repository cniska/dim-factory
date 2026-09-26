import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWorkspace } from "./workspace-detectors";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dim-detect-"));
  roots.push(root);
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

describe("workspace detectors", () => {
  test("detects the package manager and Biome tasks for TypeScript", () => {
    const profile = detectWorkspace(
      workspace({ "package.json": '{"packageManager":"pnpm@9.1.0"}', "biome.json": "{}" }),
    );

    expect(profile).toEqual({
      languages: ["javascript"],
      ecosystems: ["node"],
      packageManagers: ["pnpm"],
      tasks: [
        { name: "install", commandLine: "pnpm install", source: "detector:typescript" },
        {
          name: "analyze",
          commandLine: "pnpx biome check $FILES",
          source: "detector:typescript",
        },
        {
          name: "format",
          commandLine: "pnpx biome check --write $FILES",
          source: "detector:typescript",
        },
      ],
    });
  });

  test("detects Python tooling from Ruff configuration", () => {
    const profile = detectWorkspace(workspace({ "pyproject.toml": "[tool.ruff]\n" }));

    expect(profile?.ecosystems).toEqual(["python"]);
    expect(profile?.packageManagers).toEqual(["pip"]);
    expect(profile?.tasks).toEqual([
      { name: "install", commandLine: "pip install -e .", source: "detector:python" },
      { name: "analyze", commandLine: "ruff check $FILES", source: "detector:python" },
      { name: "format", commandLine: "ruff format $FILES", source: "detector:python" },
      { name: "test", commandLine: "pytest $FILES", source: "detector:python" },
    ]);
  });

  test("detects Go and Rust lifecycle tasks", () => {
    const go = detectWorkspace(workspace({ "go.mod": "module example.test/app" }));
    const rust = detectWorkspace(workspace({ "Cargo.toml": '[package]\nname = "app"\n' }));

    expect(go?.tasks.map((one) => one.commandLine)).toEqual([
      "go mod download",
      "go vet $FILES",
      "gofmt -w $FILES",
      "go test $FILES",
    ]);
    expect(rust?.tasks.map((one) => one.commandLine)).toEqual([
      "cargo fetch",
      "cargo clippy --all-targets -- -D warnings $FILES",
      "cargo fmt -- $FILES",
      "cargo test -- $FILES",
    ]);
  });

  test("composes every matching ecosystem", () => {
    const profile = detectWorkspace(
      workspace({
        "package.json": "{}",
        "pnpm-lock.yaml": "",
        "pubspec.yaml": "name: app\n",
      }),
    );

    expect(profile?.languages).toEqual(["javascript", "dart"]);
    expect(profile?.ecosystems).toEqual(["node", "dart"]);
    expect(profile?.packageManagers).toEqual(["pnpm", "dart"]);
    expect(profile?.tasks.map((one) => one.source)).toContain("detector:typescript");
    expect(profile?.tasks.map((one) => one.source)).toContain("detector:dart");
  });

  test("returns no profile for an unknown workspace", () => {
    expect(detectWorkspace(workspace({ "README.md": "nothing" }))).toBeNull();
  });
});

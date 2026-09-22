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
  test("detects the package manager and Biome commands for TypeScript", () => {
    const profile = detectWorkspace(
      workspace({ "package.json": '{"packageManager":"pnpm@9.1.0"}', "biome.json": "{}" }),
    );

    expect(profile).toEqual({
      ecosystem: "typescript",
      packageManager: "pnpm",
      installCommand: { bin: "pnpm", args: ["install"] },
      lintCommand: { bin: "pnpx", args: ["biome", "check", "$FILES"] },
      formatCommand: { bin: "pnpx", args: ["biome", "check", "--write", "$FILES"] },
      testCommand: null,
    });
  });

  test("detects Python tooling from Ruff configuration", () => {
    const profile = detectWorkspace(workspace({ "pyproject.toml": "[tool.ruff]\n" }));

    expect(profile?.ecosystem).toBe("python");
    expect(profile?.packageManager).toBe("pip");
    expect(profile?.lintCommand).toEqual({ bin: "ruff", args: ["check", "$FILES"] });
    expect(profile?.formatCommand).toEqual({ bin: "ruff", args: ["format", "$FILES"] });
    expect(profile?.testCommand).toEqual({ bin: "pytest", args: ["$FILES"] });
  });

  test("detects Go and Rust lifecycle commands", () => {
    const go = detectWorkspace(workspace({ "go.mod": "module example.test/app" }));
    const rust = detectWorkspace(workspace({ "Cargo.toml": '[package]\nname = "app"\n' }));

    expect(go?.testCommand).toEqual({ bin: "go", args: ["test", "$FILES"] });
    expect(go?.formatCommand).toEqual({ bin: "gofmt", args: ["-w", "$FILES"] });
    expect(rust?.lintCommand).toEqual({
      bin: "cargo",
      args: ["clippy", "--all-targets", "--", "-D", "warnings", "$FILES"],
    });
    expect(rust?.testCommand).toEqual({ bin: "cargo", args: ["test", "--", "$FILES"] });
  });

  test("returns no profile for an unknown workspace", () => {
    expect(detectWorkspace(workspace({ "README.md": "nothing" }))).toBeNull();
  });
});

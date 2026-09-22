import { existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "./workspace-commands";

export type DetectedCommand = { readonly bin: string; readonly args: readonly string[] };

export type WorkspaceDetection = {
  readonly ecosystem: string;
  readonly packageManager: string | null;
  readonly installCommand: DetectedCommand | null;
  readonly lintCommand: DetectedCommand | null;
  readonly formatCommand: DetectedCommand | null;
  readonly testCommand: DetectedCommand | null;
};

type DetectionContext = { workspace: string; packageManager: string | null };
type Detector = {
  id: string;
  match: (workspace: string) => boolean;
  packageManager?: (workspace: string) => string | null;
  install?: (context: DetectionContext) => DetectedCommand | null;
  lint?: (context: DetectionContext) => DetectedCommand | null;
  format?: (context: DetectionContext) => DetectedCommand | null;
  test?: (context: DetectionContext) => DetectedCommand | null;
};

function exists(workspace: string, name: string): boolean {
  return existsSync(join(workspace, name));
}

function text(workspace: string, name: string): string | null {
  return readManifest(join(workspace, name));
}

function packageRunner(packageManager: string | null): DetectedCommand {
  if (packageManager === "bun") return { bin: "bunx", args: [] };
  if (packageManager === "pnpm") return { bin: "pnpx", args: [] };
  if (packageManager === "yarn") return { bin: "yarn", args: ["dlx"] };
  return { bin: "npx", args: [] };
}

function packageJson(workspace: string): Record<string, unknown> | null {
  const source = text(workspace, "package.json");
  if (source === null) return null;
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function packageManagerFromJson(workspace: string): string | null {
  const value = packageJson(workspace)?.packageManager;
  if (typeof value === "string") {
    const name = value.split("@")[0] ?? "";
    if (["bun", "npm", "pnpm", "yarn"].includes(name)) return name;
  }
  for (const [file, manager] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (exists(workspace, file)) return manager;
  }
  return "npm";
}

const typescriptDetector: Detector = {
  id: "typescript",
  match: (workspace) => exists(workspace, "package.json") || exists(workspace, "deno.json"),
  packageManager: packageManagerFromJson,
  install: ({ packageManager }) => ({ bin: packageManager ?? "npm", args: ["install"] }),
  lint(context) {
    const runner = packageRunner(context.packageManager);
    if (exists(context.workspace, "biome.json") || exists(context.workspace, "biome.jsonc")) {
      return { bin: runner.bin, args: [...runner.args, "biome", "check", "$FILES"] };
    }
    if (exists(context.workspace, "oxlintrc.json"))
      return { bin: runner.bin, args: [...runner.args, "oxlint", "$FILES"] };
    if (
      [
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
      ].some((name) => exists(context.workspace, name))
    ) {
      return { bin: runner.bin, args: [...runner.args, "eslint", "$FILES"] };
    }
    if (exists(context.workspace, "deno.json") || exists(context.workspace, "deno.jsonc")) {
      return { bin: "deno", args: ["lint", "$FILES"] };
    }
    return null;
  },
  format(context) {
    const runner = packageRunner(context.packageManager);
    if (exists(context.workspace, "biome.json") || exists(context.workspace, "biome.jsonc")) {
      return { bin: runner.bin, args: [...runner.args, "biome", "check", "--write", "$FILES"] };
    }
    if (exists(context.workspace, ".prettierrc") || exists(context.workspace, ".prettierrc.json")) {
      return { bin: runner.bin, args: [...runner.args, "prettier", "--write", "$FILES"] };
    }
    if (exists(context.workspace, "deno.json") || exists(context.workspace, "deno.jsonc")) {
      return { bin: "deno", args: ["fmt", "$FILES"] };
    }
    return null;
  },
  test(context) {
    const runner = packageRunner(context.packageManager);
    const scripts = packageJson(context.workspace)?.scripts;
    const testScript =
      typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
        ? (scripts as Record<string, unknown>).test
        : null;
    if (typeof testScript === "string" && testScript.includes("vitest")) {
      return { bin: runner.bin, args: [...runner.args, "vitest", "$FILES"] };
    }
    if (typeof testScript === "string" && testScript.includes("jest")) {
      return { bin: runner.bin, args: [...runner.args, "jest", "$FILES"] };
    }
    if (
      exists(context.workspace, "vitest.config.ts") ||
      exists(context.workspace, "vitest.config.js") ||
      exists(context.workspace, "vitest.config.mts")
    ) {
      return { bin: runner.bin, args: [...runner.args, "vitest", "$FILES"] };
    }
    if (
      exists(context.workspace, "jest.config.js") ||
      exists(context.workspace, "jest.config.ts") ||
      exists(context.workspace, "jest.config.mjs")
    ) {
      return { bin: runner.bin, args: [...runner.args, "jest", "$FILES"] };
    }
    if (context.packageManager === "bun") return { bin: "bun", args: ["test", "$FILES"] };
    if (exists(context.workspace, "deno.json") || exists(context.workspace, "deno.jsonc")) {
      return { bin: "deno", args: ["test", "$FILES"] };
    }
    return null;
  },
};

const pythonDetector: Detector = {
  id: "python",
  match: (workspace) =>
    exists(workspace, "pyproject.toml") || exists(workspace, "setup.py") || exists(workspace, "ruff.toml"),
  packageManager: (workspace) =>
    exists(workspace, "uv.lock")
      ? "uv"
      : exists(workspace, "poetry.lock")
        ? "poetry"
        : exists(workspace, "Pipfile.lock")
          ? "pipenv"
          : "pip",
  install: ({ packageManager }) =>
    packageManager === "uv"
      ? { bin: "uv", args: ["sync"] }
      : packageManager === "poetry"
        ? { bin: "poetry", args: ["install"] }
        : packageManager === "pipenv"
          ? { bin: "pipenv", args: ["install"] }
          : { bin: "pip", args: ["install", "-e", "."] },
  lint(context) {
    const pyproject = text(context.workspace, "pyproject.toml");
    if (exists(context.workspace, "ruff.toml") || pyproject?.includes("[tool.ruff]"))
      return { bin: "ruff", args: ["check", "$FILES"] };
    if (exists(context.workspace, ".flake8") || pyproject?.includes("[tool.flake8]"))
      return { bin: "flake8", args: ["$FILES"] };
    if (exists(context.workspace, ".pylintrc") || pyproject?.includes("[tool.pylint]"))
      return { bin: "pylint", args: ["$FILES"] };
    if (exists(context.workspace, "mypy.ini") || pyproject?.includes("[tool.mypy]"))
      return { bin: "mypy", args: ["$FILES"] };
    return null;
  },
  format(context) {
    const pyproject = text(context.workspace, "pyproject.toml");
    if (exists(context.workspace, "ruff.toml") || pyproject?.includes("[tool.ruff]"))
      return { bin: "ruff", args: ["format", "$FILES"] };
    if (exists(context.workspace, ".black") || pyproject?.includes("[tool.black]"))
      return { bin: "black", args: ["$FILES"] };
    return null;
  },
  test(context) {
    const pyproject = text(context.workspace, "pyproject.toml");
    if (
      pyproject?.includes("[tool.pytest]") ||
      exists(context.workspace, "pytest.ini") ||
      exists(context.workspace, "pyproject.toml") ||
      exists(context.workspace, "setup.py")
    )
      return { bin: "pytest", args: ["$FILES"] };
    if (pyproject?.includes("[tool.nose2]")) return { bin: "nose2", args: ["$FILES"] };
    return null;
  },
};

const goDetector: Detector = {
  id: "go",
  match: (workspace) => exists(workspace, "go.mod"),
  install: () => ({ bin: "go", args: ["mod", "download"] }),
  lint: (context) =>
    exists(context.workspace, ".golangci.yml") || exists(context.workspace, ".golangci.yaml")
      ? { bin: "golangci-lint", args: ["run", "$FILES"] }
      : { bin: "go", args: ["vet", "$FILES"] },
  format: () => ({ bin: "gofmt", args: ["-w", "$FILES"] }),
  test: () => ({ bin: "go", args: ["test", "$FILES"] }),
};

const rustDetector: Detector = {
  id: "rust",
  match: (workspace) => exists(workspace, "Cargo.toml"),
  install: () => ({ bin: "cargo", args: ["fetch"] }),
  lint: () => ({ bin: "cargo", args: ["clippy", "--all-targets", "--", "-D", "warnings", "$FILES"] }),
  format: () => ({ bin: "cargo", args: ["fmt", "--", "$FILES"] }),
  test: () => ({ bin: "cargo", args: ["test", "--", "$FILES"] }),
};

function dartKind(workspace: string): "dart" | "flutter" {
  const pubspec = text(workspace, "pubspec.yaml") ?? "";
  return /^\s+flutter:\s*$/m.test(pubspec) && /^\s+sdk:\s+flutter\s*$/m.test(pubspec) ? "flutter" : "dart";
}

const dartDetector: Detector = {
  id: "dart",
  match: (workspace) => exists(workspace, "pubspec.yaml"),
  packageManager: dartKind,
  install: (context) => ({
    bin: context.packageManager === "flutter" ? "flutter" : "dart",
    args: ["pub", "get"],
  }),
  lint: (context) => ({
    bin: context.packageManager === "flutter" ? "flutter" : "dart",
    args: ["analyze", "$FILES"],
  }),
  format: () => ({ bin: "dart", args: ["format", "$FILES"] }),
  test: (context) => ({
    bin: context.packageManager === "flutter" ? "flutter" : "dart",
    args: ["test", "$FILES"],
  }),
};

export const WORKSPACE_DETECTORS: readonly Detector[] = [
  typescriptDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  dartDetector,
];

export function detectWorkspace(workspace: string): WorkspaceDetection | null {
  const detector = WORKSPACE_DETECTORS.find((candidate) => candidate.match(workspace));
  if (!detector) return null;
  const packageManager = detector.packageManager?.(workspace) ?? null;
  const context = { workspace, packageManager };
  return {
    ecosystem: detector.id === "dart" ? (packageManager ?? "dart") : detector.id,
    packageManager,
    installCommand: detector.install?.(context) ?? null,
    lintCommand: detector.lint?.(context) ?? null,
    formatCommand: detector.format?.(context) ?? null,
    testCommand: detector.test?.(context) ?? null,
  };
}

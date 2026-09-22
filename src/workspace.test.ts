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
    expect(contract.checkCommand).toBeNull();
    expect(contract.formatCommand?.command).toBe("bun run format");
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
    expect(contract.bootstrap).toEqual({ value: ["flutter", "pub", "get"], source: "pubspec.yaml" });
    expect(contract.capabilities).toEqual({ format: true, analyze: true, test: true });
  });

  test("keeps an ordinary Dart package distinct from Flutter", () => {
    const root = repo({ "pubspec.yaml": "name: parser\ndependencies:\n  meta: ^1.0.0\n" });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.ecosystems).toEqual(["dart"]);
    expect(contract.packageManagers).toEqual(["dart"]);
    expect(contract.bootstrap).toEqual({ value: ["dart", "pub", "get"], source: "pubspec.yaml" });
    expect(contract.capabilities).toEqual({ format: false, analyze: false, test: false });
    expect(contract.detected).toEqual({
      ecosystem: "dart",
      packageManager: "dart",
      installCommand: { bin: "dart", args: ["pub", "get"] },
      lintCommand: { bin: "dart", args: ["analyze", "$FILES"] },
      formatCommand: { bin: "dart", args: ["format", "$FILES"] },
      testCommand: { bin: "dart", args: ["test", "$FILES"] },
    });
  });

  test("detects Flutter tooling when the repository has no declared tasks", () => {
    const root = repo({
      "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.detected?.ecosystem).toBe("flutter");
    expect(contract.detected?.packageManager).toBe("flutter");
    expect(contract.detected?.testCommand).toEqual({ bin: "flutter", args: ["test", "$FILES"] });
  });

  test("separates a repository with no compose file from one whose compose file names no services", () => {
    const silent = workspaceContract(repo({ "package.json": "{}" }));
    const empty = workspaceContract(repo({ "compose.yaml": "services:\n" }));
    if (silent === null || empty === null) throw new Error("expected a workspace contract");

    expect(silent.services).toBeNull();
    expect(empty.services).toEqual({ value: [], source: "compose.yaml" });
  });

  test("names the services a compose file declares without reading their shape", () => {
    const root = repo({
      "docker-compose.yml": [
        "services:",
        "  postgres: &db",
        "    image: postgres:16",
        "    ports:",
        "      - 5432:5432",
        "# the cache came later",
        "  redis:",
        "    image: redis",
        "volumes:",
        "  pgdata:",
      ].join("\n"),
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.services).toEqual({ value: ["postgres", "redis"], source: "docker-compose.yml" });
  });

  test("reads services written as a flow mapping", () => {
    const root = repo({ "compose.yaml": 'services: {api: {}, "db": {}}\n' });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.services).toEqual({ value: ["api", "db"], source: "compose.yaml" });
  });

  test("ignores a services key nested under another top-level key", () => {
    const root = repo({ "compose.yaml": "x-defaults:\n  services:\n    fake:\n" });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.services).toEqual({ value: [], source: "compose.yaml" });
  });

  test("stays silent about a compose file it cannot read as a mapping", () => {
    const listed = workspaceContract(repo({ "compose.yaml": "services:\n  - api\n" }));
    const unparsed = workspaceContract(repo({ "compose.yaml": "services:\n\tapi:\n  db:\n" }));
    const multidoc = workspaceContract(
      repo({ "compose.yaml": "services:\n  api:\n---\nservices:\n  db:\n" }),
    );
    const scalar = workspaceContract(repo({ "compose.yaml": "just a sentence\n" }));
    if (listed === null || unparsed === null || multidoc === null || scalar === null) {
      throw new Error("expected a workspace contract");
    }

    expect(listed.services).toBeNull();
    expect(unparsed.services).toBeNull();
    expect(multidoc.services).toBeNull();
    expect(scalar.services).toBeNull();
  });

  test("prefers the compose file Compose itself would resolve first", () => {
    const root = repo({
      "compose.yaml": "services:\n  api:\n",
      "docker-compose.yml": "services:\n  legacy:\n",
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.services).toEqual({ value: ["api"], source: "compose.yaml" });
  });

  test("names the variables a sample environment file declares and none of their values", () => {
    const root = repo({
      ".env.example": [
        "# Copy to .env and fill in.",
        "SUPABASE_URL=http://127.0.0.1:54321",
        "",
        // Shaped like a key but matching no scanner's pattern: a fixture that reads as a live
        // credential is one a push protection rule blocks, and the test is about the name only.
        "export STRIPE_SECRET_KEY=placeholder-value-never-recorded",
        "  SPACED_NAME = value",
        "SUPABASE_URL=repeated",
        "not a declaration",
      ].join("\n"),
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.requiredEnvironment).toEqual({
      value: ["SUPABASE_URL", "STRIPE_SECRET_KEY", "SPACED_NAME"],
      source: ".env.example",
    });
    expect(JSON.stringify(contract)).not.toContain("placeholder-value-never-recorded");
    expect(JSON.stringify(contract)).not.toContain("54321");
  });

  test("reads no part of a value that runs across several lines", () => {
    const root = repo({
      ".env.example": [
        'SIGNING_KEY="-----BEGIN PRIVATE KEY-----',
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj=",
        'PASSWORD=hunter2-----END PRIVATE KEY-----"',
        "AFTER=1",
      ].join("\n"),
    });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.requiredEnvironment).toEqual({
      value: ["SIGNING_KEY", "AFTER"],
      source: ".env.example",
    });
    expect(JSON.stringify(contract)).not.toContain("MIIEvQ");
  });

  test("stops at a value whose quote is never closed", () => {
    const root = repo({ ".env.example": 'CERT="-----BEGIN\nPASSWORD=hunter2\n' });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.requiredEnvironment).toEqual({ value: ["CERT"], source: ".env.example" });
  });

  test("never opens the filled-in environment file", () => {
    const root = repo({ ".env": "STRIPE_SECRET_KEY=placeholder-value-never-recorded\n" });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.requiredEnvironment).toBeNull();
    expect(JSON.stringify(contract)).not.toContain("STRIPE_SECRET_KEY");
  });

  test("separates a repository with no sample file from one whose sample names nothing", () => {
    const silent = workspaceContract(repo({ "package.json": "{}" }));
    const empty = workspaceContract(repo({ ".env.sample": "# nothing needed yet\n" }));
    if (silent === null || empty === null) throw new Error("expected a workspace contract");

    expect(silent.requiredEnvironment).toBeNull();
    expect(empty.requiredEnvironment).toEqual({ value: [], source: ".env.sample" });
  });

  test("prefers the sample file a contributor is told to copy first", () => {
    const root = repo({ ".env.example": "FROM_EXAMPLE=\n", ".env.template": "FROM_TEMPLATE=\n" });
    const contract = workspaceContract(root);
    if (contract === null) throw new Error("expected a workspace contract");

    expect(contract.requiredEnvironment).toEqual({ value: ["FROM_EXAMPLE"], source: ".env.example" });
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

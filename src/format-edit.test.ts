import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editedPaths, formatAfterEdit } from "./format-edit";

const roots: string[] = [];

function checkout(scripts: Record<string, string> | null): string {
  const root = mkdtempSync(join(tmpdir(), "dim-format-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  if (scripts) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
    writeFileSync(join(root, "bun.lock"), "");
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the paths an edit touched", () => {
  test("a Claude file tool names its file, resolved against the session's directory", () => {
    expect(editedPaths({ tool_name: "Edit", cwd: "/repo", tool_input: { file_path: "src/a.ts" } })).toEqual([
      "/repo/src/a.ts",
    ]);
    expect(editedPaths({ tool_name: "Write", tool_input: { file_path: "/repo/b.ts" } })).toEqual([
      "/repo/b.ts",
    ]);
    expect(
      editedPaths({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/n.ipynb" } }),
    ).toEqual(["/repo/n.ipynb"]);
  });

  test("a Codex patch names every file it adds, updates or moves to, and not one it deletes", () => {
    const command = [
      "*** Begin Patch",
      "*** Add File: /repo/new.ts",
      "+export {};",
      "*** Update File: /repo/old.ts",
      "*** Move to: /repo/moved.ts",
      "*** Delete File: /repo/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(editedPaths({ tool_name: "apply_patch", tool_input: { command } })).toEqual([
      "/repo/new.ts",
      "/repo/old.ts",
      "/repo/moved.ts",
    ]);
  });

  test("any other tool edited nothing", () => {
    expect(editedPaths({ tool_name: "Bash", tool_input: { command: "*** Add File: /repo/x.ts" } })).toEqual(
      [],
    );
    expect(editedPaths({})).toEqual([]);
  });
});

describe("formatting after an edit", () => {
  test("runs the repo's declared format task once in the checkout the file is in", () => {
    const root = checkout({ format: "touch formatted" });
    const runs = formatAfterEdit({
      tool_name: "MultiEdit",
      tool_input: { file_path: join(root, "src", "a.ts") },
    });
    expect(runs).toEqual([{ checkout: root, commandLine: "bun run format", exitCode: 0 }]);
    expect(existsSync(join(root, "formatted"))).toBe(true);
  });

  test("a failing format task is reported and does not throw", () => {
    const root = checkout({ format: "exit 3" });
    expect(formatAfterEdit({ tool_name: "Write", tool_input: { file_path: join(root, "a.ts") } })).toEqual([
      { checkout: root, commandLine: "bun run format", exitCode: 3 },
    ]);
  });

  test("a repo that declares no format task, or a file outside any checkout, runs nothing", () => {
    const bare = checkout(null);
    expect(formatAfterEdit({ tool_name: "Write", tool_input: { file_path: join(bare, "a.ts") } })).toEqual(
      [],
    );
    const outside = mkdtempSync(join(tmpdir(), "dim-format-outside-"));
    roots.push(outside);
    expect(formatAfterEdit({ tool_name: "Write", tool_input: { file_path: join(outside, "a.ts") } })).toEqual(
      [],
    );
  });
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./commands";

const SRC = import.meta.dir;
const RAW_OUTPUT = [
  "check-command-command.ts",
  "comments-command.ts",
  "operator-command.ts",
  "trace-command.ts",
  "wake-command.ts",
  "wt-command.ts",
];

function sources(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$|test-support/.test(path));
}

describe("the command contract", () => {
  test("cli.ts only dispatches through the list of commands", () => {
    const imports = [...readFileSync(join(SRC, "cli.ts"), "utf8").matchAll(/from "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["./command", "./command-output", "./commands"]);
  });

  test("only the writer and the raw commands write to stdout", () => {
    const writers = sources().filter((path) =>
      /console\.log|process\.stdout\.write/.test(readFileSync(join(SRC, path), "utf8")),
    );
    expect(writers.sort()).toEqual(["command-output.ts", ...RAW_OUTPUT].sort());
  });

  test("every command declared is on the list, once", () => {
    const declared = sources().flatMap((path) =>
      [...readFileSync(join(SRC, path), "utf8").matchAll(/export const (\w+): Command = \{/g)].map(
        (m) => m[1],
      ),
    );
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(declared).toHaveLength(COMMANDS.length);
  });

  test("each command file holds one command, named for the file", () => {
    for (const path of sources().filter((p) => p.endsWith("-command.ts"))) {
      const declared = [
        ...readFileSync(join(SRC, path), "utf8").matchAll(
          /export const \w+: Command = \{\s*name: "([^"]+)"/g,
        ),
      ];
      expect({ path, names: declared.map((m) => m[1]) }).toEqual({
        path,
        names: [path.replace(/-command\.ts$/, "")],
      });
    }
  });

  test("every command states its usage and what it is for", () => {
    for (const command of COMMANDS) {
      expect(command.usage).toStartWith(`usage: dim ${command.name}`);
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });
});

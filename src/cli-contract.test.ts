import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allCommands, findCommand } from "./cli-commands";
import { scratchEnv } from "./fixtures.test-support";

const COMMANDS = await allCommands();

const SRC = import.meta.dir;
const RAW_OUTPUT = ["hooks-start.ts", "trace-command.ts"];

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
    expect(imports.sort()).toEqual(["./cli-commands", "./cli-contract", "./cli-output"]);
  });

  test("only the writer and the raw commands write to stdout", () => {
    const writers = sources().filter((path) =>
      /console\.log|process\.stdout\.write/.test(readFileSync(join(SRC, path), "utf8")),
    );
    expect(writers.sort()).toEqual(["cli-output.ts", ...RAW_OUTPUT].sort());
  });

  test("only the list of commands imports a command file", () => {
    const importers = sources().filter(
      (path) =>
        path !== "cli-commands.ts" &&
        /(?:from |import\()"\.\/[a-z-]+-command"/.test(readFileSync(join(SRC, path), "utf8")),
    );
    expect(importers).toEqual([]);
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

  test("a name loads the command it names, and nothing else", async () => {
    for (const command of COMMANDS) {
      expect((await findCommand(command.name))?.name).toBe(command.name);
    }
    expect(findCommand("constructor")).toBeUndefined();
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

  test("a command that takes no arguments refuses one", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-no-args-"));
    try {
      for (const name of ["sync", "rebuild", "doctor"]) {
        const run = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), name, "extra"], {
          env: { ...process.env, ...scratchEnv(root) },
        });
        expect({ name, exitCode: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({
          name,
          exitCode: 1,
          stderr: expect.stringContaining('"code":"usage"'),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every command states its usage and what it is for", () => {
    for (const command of COMMANDS) {
      expect(command.usage).toStartWith(`usage: dim ${command.name}`);
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });
});

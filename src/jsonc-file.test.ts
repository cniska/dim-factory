import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config-error";
import { readJsonc, readJsoncText } from "./jsonc-file";

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "dim-jsonc-file-"));
}

describe("reading a config from disk", () => {
  test("reads a config carrying comments", () => {
    const dir = newDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{\n  // the notifier\n  "hooks": {},\n}\n');

    expect(readJsonc<{ hooks: unknown }>(path)).toEqual({ hooks: {} });
    expect(readJsoncText(path)).toContain("// the notifier");
  });

  test("tells an absent file from an empty one", () => {
    const dir = newDir();
    const absent = join(dir, "absent.json");
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "");

    expect(readJsonc(absent)).toBeNull();
    expect(readJsoncText(absent)).toBe("");
    expect(() => readJsonc(empty)).toThrow(ConfigError);
  });

  test("raises a parse error naming the file it read", () => {
    const dir = newDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{ "hooks": ');

    try {
      readJsonc(path);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).kind).toBe("parse");
      expect((e as ConfigError).path).toBe(path);
    }
  });
});

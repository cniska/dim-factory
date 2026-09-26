import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config-error";
import { appendToJsoncArray, parseJsonc } from "./jsonc";

const entry = { hooks: [{ type: "command", command: "dim-spool" }] };

describe("reading a config a person edits", () => {
  test("accepts the comments and trailing commas a tool config carries", () => {
    const text = `{
  // the one that writes the spool
  "hooks": {},
}
`;
    expect(parseJsonc<{ hooks: unknown }>(text, "settings.json")).toEqual({ hooks: {} });
  });

  test("raises a parse error rather than a half-read config", () => {
    try {
      parseJsonc('{ "hooks": ', "settings.json");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).kind).toBe("parse");
      expect((e as ConfigError).path).toBe("settings.json");
    }
  });
});

describe("appending to an array in place", () => {
  test("leaves a comment and the keys around the insertion untouched", () => {
    const text = `{
  // keep me
  "otherSetting": true,
  "hooks": {
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "existing" }] }]
  }
}
`;
    const after = appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json");
    expect(after).toContain("// keep me");
    expect(after).toContain('"otherSetting": true');
    expect(after).toContain('"command": "existing"');
    expect(after).toContain('"command": "dim-spool"');
  });

  test("writes the insertion at the indent the file already uses", () => {
    const text = `{
    "hooks": {
        "SessionEnd": []
    }
}
`;
    const after = appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json");
    expect(after).toContain('\n                "hooks": [');
  });

  test("uses tabs where the file does", () => {
    const text = '{\n\t"hooks": {\n\t\t"SessionEnd": []\n\t}\n}\n';
    expect(appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json")).toContain(
      '\n\t\t\t\t"hooks": [',
    );
  });

  test("creates the array and its parents where they are absent", () => {
    const after = appendToJsoncArray("", ["hooks", "SessionStart"], entry, "settings.json");
    expect(parseJsonc<{ hooks: Record<string, unknown[]> }>(after, "new").hooks.SessionStart).toEqual([
      entry,
    ]);
    expect(after).toEndWith("\n");
  });

  test("appends beside what is there rather than replacing it", () => {
    const text = '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"existing"}]}]}}';
    const after = appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json");
    const parsed = parseJsonc<{ hooks: Record<string, { hooks: { command: string }[] }[]> }>(
      after,
      "settings.json",
    );
    expect(parsed.hooks.SessionEnd?.map((e) => e.hooks[0]?.command)).toEqual(["existing", "dim-spool"]);
  });

  test("leaves a file that ends without a newline ending without one", () => {
    const after = appendToJsoncArray(
      '{"hooks":{"SessionEnd":[]}}',
      ["hooks", "SessionEnd"],
      entry,
      "settings.json",
    );
    expect(after).not.toEndWith("\n");
  });

  test("refuses a path holding something that is not an array", () => {
    const text = '{"hooks":{"SessionEnd":"not-an-array"}}';
    try {
      appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).kind).toBe("not-an-array");
    }
  });

  test("refuses a parent holding something that is not an object", () => {
    try {
      appendToJsoncArray('{"hooks":"x"}', ["hooks", "SessionEnd"], entry, "settings.json");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).kind).toBe("not-an-object");
      expect((e as ConfigError).at).toBe("hooks");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { appendToJsoncArray, parseJsonc, removeJsoncValue } from "./config-jsonc";

const AnyConfig = z.looseObject({ hooks: z.unknown() });
const HookConfig = z.looseObject({
  hooks: z.record(
    z.string(),
    z.array(z.looseObject({ hooks: z.array(z.looseObject({ command: z.string() })) })),
  ),
});

const entry = { hooks: [{ type: "command", command: "dim-spool" }] };

describe("reading a config a person edits", () => {
  test("accepts the comments and trailing commas a tool config carries", () => {
    const text = `{
  // the one that writes the spool
  "hooks": {},
}
`;
    expect(parseJsonc(text, "settings.json", AnyConfig)).toEqual({ hooks: {} });
  });

  test("refuses a config whose read part has the wrong shape, naming the path into it", () => {
    expect(() => parseJsonc('{ "hooks": { "Stop": "x" } }', "settings.json", HookConfig)).toThrow(
      expect.objectContaining({
        code: "config_invalid",
        meta: expect.objectContaining({ path: "settings.json", at: "hooks.Stop" }),
      }),
    );
    expect(() => parseJsonc("[]", "settings.json", HookConfig)).toThrow(
      expect.objectContaining({ code: "config_invalid", meta: expect.objectContaining({ at: null }) }),
    );
  });

  test("raises a parse error rather than a half-read config", () => {
    expect(() => parseJsonc('{ "hooks": ', "settings.json", AnyConfig)).toThrow(
      expect.objectContaining({
        code: "config_unparsed",
        meta: expect.objectContaining({ path: "settings.json" }),
      }),
    );
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
    expect(parseJsonc(after, "new", HookConfig).hooks.SessionStart).toEqual([entry]);
    expect(after).toEndWith("\n");
  });

  test("appends beside what is there rather than replacing it", () => {
    const text = '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"existing"}]}]}}';
    const after = appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json");
    const parsed = parseJsonc(after, "settings.json", HookConfig);
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
    expect(() => appendToJsoncArray(text, ["hooks", "SessionEnd"], entry, "settings.json")).toThrow(
      expect.objectContaining({ code: "config_not_an_array" }),
    );
  });

  test("refuses a parent holding something that is not an object", () => {
    expect(() =>
      appendToJsoncArray('{"hooks":"x"}', ["hooks", "SessionEnd"], entry, "settings.json"),
    ).toThrow(
      expect.objectContaining({
        code: "config_not_an_object",
        meta: expect.objectContaining({ at: "hooks" }),
      }),
    );
  });
});

describe("removing a value", () => {
  const config = {
    hooks: { P: [{ hooks: ["s"] }, { hooks: ["u", "s"] }, { m: 1, hooks: ["e"] }] },
    keep: true,
  };
  const cases: [string, (string | number)[], unknown][] = [
    ["the first item", ["hooks", "P", 0], [{ hooks: ["u", "s"] }, { m: 1, hooks: ["e"] }]],
    ["the last item", ["hooks", "P", 2], [{ hooks: ["s"] }, { hooks: ["u", "s"] }]],
    [
      "a nested last item",
      ["hooks", "P", 1, "hooks", 1],
      [{ hooks: ["s"] }, { hooks: ["u"] }, { m: 1, hooks: ["e"] }],
    ],
  ];

  for (const [layout, text] of [
    ["compact", JSON.stringify(config)],
    ["indented", JSON.stringify(config, null, 2)],
  ] as const) {
    for (const [what, path, left] of cases) {
      test(`takes ${what} out of ${layout} JSON and leaves it valid`, () => {
        const after = JSON.parse(removeJsoncValue(text, path, "settings.json"));
        expect(after.hooks.P).toEqual(left);
        expect(after.keep).toBe(true);
      });
    }
  }

  test("removes the only item, leaving an empty array", () => {
    expect(JSON.parse(removeJsoncValue('{"a":[1]}', ["a", 0], "settings.json"))).toEqual({ a: [] });
  });

  test("refuses a path the config does not hold", () => {
    expect(() => removeJsoncValue('{"a":[1]}', ["a", 3], "settings.json")).toThrow(
      expect.objectContaining({ code: "config_absent" }),
    );
  });
});

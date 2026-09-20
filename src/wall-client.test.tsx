import { describe, expect, test } from "bun:test";

describe("item changes", () => {
  test("places the per-file summary beside the history", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).toContain(
      "read.view.changes.length > 0 ? <ItemChanges changes={read.view.changes} /> : null",
    );
    expect(source).toContain('className="text-role-builder">+{change.added}</span>');
    expect(source).toContain('className="text-danger"> −{change.removed}</span>');
  });
});

import { describe, expect, test } from "bun:test";

describe("item history", () => {
  test("keeps per-file evidence out of the wall", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).not.toContain("read.view.changes.length > 0 ? <ItemChanges");
    expect(source).not.toContain('className="text-role-builder">+{change.added}</span>');
    expect(source).not.toContain('className="text-danger"> −{change.removed}</span>');
  });
});

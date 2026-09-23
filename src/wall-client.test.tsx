import { describe, expect, test } from "bun:test";

describe("item history", () => {
  test("keeps per-file evidence out of the wall", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).not.toContain("read.view.changes.length > 0 ? <ItemChanges");
    expect(source).not.toContain('className="text-role-builder">+{change.added}</span>');
    expect(source).not.toContain('className="text-danger"> −{change.removed}</span>');
  });

  test("keeps the audit log's bottom inset equal to its other sides", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).toContain('className="min-w-0 space-y-5 text-[12px]"');
    expect(source).toContain('className="mb-5 text-[12px] leading-[18px] text-quiet"');
    expect(source).toContain('className="space-y-5"');
    expect(source).not.toContain("first:pt-0");
  });

  test("renders the description on cards and in the item dialog", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).toContain('className="line-clamp-3 min-h-[54px] shrink-0 text-quiet leading-[18px]"');
    expect(source).toContain('className="whitespace-pre-wrap text-quiet leading-5"');
  });

  test("labels the plan and audit log in the detail view", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).toContain('aria-labelledby="item-plan"');
    expect(source).toMatch(/>\s*Plan\s*</);
    expect(source).toContain('aria-labelledby="item-log"');
    expect(source).toMatch(/>\s*Log\s*</);
    expect(source).toMatch(
      /\{read\.view\?\.plan \? <div className="border-t" aria-hidden="true" \/> : null\}/,
    );
    expect(source).toContain('const NO_WORKER = "none";');
    expect(source).toContain("<dt>assignee</dt>");
    expect(source).toContain(
      'if (!entry.worker || !entry.role) return <span className="text-quiet">{NO_WORKER}</span>;',
    );
    expect(source.indexOf("<dt>order</dt>")).toBeLessThan(source.indexOf("<dt>project</dt>"));
    expect(source).toContain('if (days === 0) return "today";');
    expect(source).toContain('if (days === 1) return "yesterday";');
    expect(source).toContain(
      'const dayInYear = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });',
    );
  });
});

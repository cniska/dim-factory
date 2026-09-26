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

    expect(source).toContain('className="min-w-0 space-y-[var(--space-lg)] text-[12px]"');
    expect(source).toContain('className="flex flex-col gap-[var(--space-lg)]"');
    expect(source).toContain('className="space-y-[var(--space-lg)]"');
    expect(source).toContain(
      'className="mb-[var(--space-lg)] text-xl font-medium text-foreground leading-7"',
    );
    expect(source).not.toContain('className="mb-2 text-base font-medium text-foreground leading-6"');
    expect(source).toContain('className="flex flex-col gap-[var(--space-lg)] border-b p-[var(--space-lg)]"');
    expect(source).toContain('className="m-auto max-h-[85vh] w-[min(64rem,92vw)] rounded-lg border');
    expect(source).toContain(
      'className="min-w-0 space-y-[var(--space-lg)] px-[var(--space-lg)] pb-[var(--space-lg)] pt-[var(--space-lg)]"',
    );
    expect(source).toContain("h-[164px] justify-between p-[var(--space-md)] text-left text-[11px]");
    expect(source).toContain("cursor-pointer rounded-wall p-[var(--space-xs)]");
    expect(source).not.toContain('className="mt-2 flex flex-wrap items-center');
    expect(source).not.toContain('"mt-3 space-y-3 text-quiet"');
    expect(source).not.toContain("first:pt-0");
  });

  test("renders the description on cards and in the item dialog", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();

    expect(source).toContain('className="line-clamp-3 min-h-[54px] shrink-0 text-quiet leading-[18px]"');
    expect(source).toContain(
      'className="whitespace-pre-wrap px-[var(--space-lg)] pt-[var(--space-lg)] text-quiet leading-5"',
    );
    expect(source.indexOf('className="flex min-h-0 flex-col overflow-y-auto"')).toBeLessThan(
      source.lastIndexOf("{order.description}"),
    );
    expect(source).toContain('"wall-markdown flex flex-col gap-[var(--space-md)] text-quiet"');
    expect(source).toContain('className="text-quiet" aria-hidden="true"');
    expect(source).toContain('<span className="text-good">approved</span>');
    expect(source).not.toContain(">awaiting approval</span>");
    expect(source).toContain("[&_ol]:my-0");
    expect(source).toContain("[&_ul]:my-0");
  });

  test("labels the plan and audit log in the detail view", async () => {
    const source = await Bun.file(new URL("./wall-client.tsx", import.meta.url)).text();
    const styles = await Bun.file(new URL("./wall.css", import.meta.url)).text();

    expect(source).toContain('aria-labelledby="item-plan"');
    expect(source).toMatch(/>\s*Plan\s*</);
    expect(source).toContain('aria-labelledby="item-log"');
    expect(source).toContain('aria-labelledby="item-build"');
    expect(source).toMatch(/>\s*Build\s*</);
    expect(source).toContain('aria-labelledby="item-review"');
    expect(source).toMatch(/>\s*Review\s*</);
    expect(source).toContain("The order has not been planned.");
    expect(source).toContain("The order has not been built.");
    expect(source).toContain("The order has not been reviewed.");
    expect(source).toMatch(/>\s*Log\s*</);
    expect(source.match(/<div className="border-t" aria-hidden="true" \/>/g)).toHaveLength(3);
    expect(source).toContain('const NO_WORKER = "none";');
    expect(source).toContain("<dt>assignee</dt>");
    expect(source).toContain("STATION_LABELS[order.station]");
    expect(source).toContain("function NoWorkerLabel()");
    expect(source).toContain('<Robot label="none" className="text-quiet opacity-60" />');
    expect(source).toContain("if (!entry.worker) return <NoWorkerLabel />;");
    expect(source).toContain(
      'const LINE_LABELS: Record<OrderLine, string> = { feat: "feature", fix: "fix" };',
    );
    expect(source).toContain('size === "dialog" ? "h-[20px] w-[20px]" : "h-[12px] w-[12px]"');
    expect(source.indexOf("<dt>order</dt>")).toBeLessThan(source.indexOf("<dt>project</dt>"));
    expect(source).toContain('if (days === 0) return "today";');
    expect(source).toContain('if (days === 1) return "yesterday";');
    expect(source).toContain(
      'const dayInYear = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });',
    );
    expect(styles).toContain("--space-lg: 20px;");
  });
});

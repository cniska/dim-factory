import type { QueryResult } from "./queries";

const MAX_ROWS = 40;

function cell(value: string | number | null): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

/**
 * The denominator prints above the rows and the note below them, so a figure is
 * never read without the base it came from or the caveat it carries.
 */
export function renderTable(result: QueryResult): string {
  const out: string[] = [];
  if (result.denominator) out.push(result.denominator, "");

  if (result.rows.length === 0) {
    out.push(result.note ?? "no rows");
    return out.join("\n");
  }

  const shown = result.rows.slice(0, MAX_ROWS);
  const body = shown.map((r) => r.map(cell));
  const widths = result.columns.map((c, i) => Math.max(c.length, ...body.map((r) => (r[i] ?? "").length)));
  const numeric = result.columns.map((_, i) => shown.every((r) => typeof r[i] === "number" || r[i] === null));

  const line = (cells: string[]): string =>
    cells
      .map((v, i) => (numeric[i] ? v.padStart(widths[i] as number) : v.padEnd(widths[i] as number)))
      .join("  ")
      .trimEnd();

  out.push(line(result.columns));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) out.push(line(r));

  if (result.rows.length > shown.length) {
    out.push(`… ${result.rows.length - shown.length} more rows`);
  }
  if (result.note) out.push("", result.note);
  return out.join("\n");
}

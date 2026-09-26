import type { QueryResult } from "./queries";

export const DEFAULT_MAX_ROWS = 40;

function cell(value: string | number | null): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "number" ? String(value) : value;
}

export function renderTable(result: QueryResult, maxRows = DEFAULT_MAX_ROWS): string {
  const out: string[] = [];
  if (result.denominator) out.push(result.denominator, "");

  if (result.rows.length === 0) {
    out.push(result.note ?? "no rows");
    return out.join("\n");
  }

  const shown = result.rows.slice(0, maxRows);
  out.push(result.columns.join("  "));
  out.push(result.columns.map((c) => "-".repeat(c.length)).join("  "));
  for (const r of shown) out.push(r.map(cell).join("  ").trimEnd());

  if (result.rows.length > shown.length) {
    out.push(`… ${result.rows.length - shown.length} more rows; --rows <n> to widen`);
  }
  if (result.note) out.push("", result.note);
  return out.join("\n");
}

export function rowsFromArgs(args: string[]): number {
  const at = args.indexOf("--rows");
  if (at === -1) return DEFAULT_MAX_ROWS;
  const spec = args[at + 1];
  const n = Number(spec);
  if (!spec || !Number.isInteger(n) || n < 1) throw new Error(`--rows ${spec ?? "(missing)"} is not a count`);
  return n;
}

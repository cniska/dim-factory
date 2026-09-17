import type { QueryResult } from "./queries";

export const DEFAULT_MAX_ROWS = 40;

function cell(value: string | number | null): string {
  if (value === null || value === undefined) return "—";
  // No thousands separator: an agent reads this output far more often than a
  // person does, and a number it has to strip punctuation from is worse than one
  // it can use.
  return typeof value === "number" ? String(value) : value;
}

/**
 * The denominator prints above the rows and the note below them, so a figure is
 * never read without the base it came from or the caveat it carries.
 *
 * Cells are separated, not aligned. Padding every cell out to the widest value
 * in its column buys a reader columns that line up and costs the agent that
 * actually reads this a run of spaces on every row of every result.
 */
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

/** `--rows <n>`, the cap on how many rows are printed. Bad input is an error, not a silent default. */
export function rowsFromArgs(args: string[]): number {
  const at = args.indexOf("--rows");
  if (at === -1) return DEFAULT_MAX_ROWS;
  const spec = args[at + 1];
  const n = Number(spec);
  if (!spec || !Number.isInteger(n) || n < 1) throw new Error(`--rows ${spec ?? "(missing)"} is not a count`);
  return n;
}

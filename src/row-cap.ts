import { UsageError } from "./command";

export const DEFAULT_MAX_ROWS = 40;

export function rowsFromArgs(args: string[]): number {
  const at = args.indexOf("--rows");
  if (at === -1) return DEFAULT_MAX_ROWS;
  const spec = args[at + 1];
  const n = Number(spec);
  if (!spec || !Number.isInteger(n) || n < 1)
    throw new UsageError(`--rows ${spec ?? "(missing)"} is not a count`);
  return n;
}

export function capRows<Row>(rows: Row[], maxRows: number): { rows: Row[]; more: string | null } {
  const shown = rows.slice(0, maxRows);
  return {
    rows: shown,
    more: rows.length > shown.length ? `${rows.length - shown.length} more rows; --rows <n> to widen` : null,
  };
}

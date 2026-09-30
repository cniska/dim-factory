import { UsageError } from "./cli-contract";

export const DEFAULT_MAX_ROWS = 40;

export function rowsOf(spec: string | undefined): number {
  if (spec === undefined) return DEFAULT_MAX_ROWS;
  const n = Number(spec);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--rows ${spec} is not a count`);
  return n;
}

export function capRows<Row>(rows: Row[], maxRows: number): { rows: Row[]; more: string | null } {
  const shown = rows.slice(0, maxRows);
  return {
    rows: shown,
    more: rows.length > shown.length ? `more rows than ${maxRows}; --rows <n> to widen` : null,
  };
}

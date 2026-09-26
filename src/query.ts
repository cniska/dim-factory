import type { Database } from "bun:sqlite";
import type { Question } from "./embed";

export type QueryResult = {
  denominator: string;
  columns: string[];
  rows: (string | number | null)[][];
  note?: string;
  path?: string;
};

export type QueryContext = {
  arg?: string;
  since?: string;
  home?: string;
  question?: Question;
  windowColumn?: string | string[] | null;
};

export const homeOf = (ctx: QueryContext): string => ctx.home ?? "";

export type Query = {
  name: string;
  summary: string;
  usage?: string;
  window: string | string[] | null;
  spansHistory?: boolean;
  embedsArg?: boolean;
  run: (db: Database, ctx: QueryContext) => QueryResult;
};

export function window(
  col: string,
  ctx: QueryContext,
  keyword: "WHERE" | "AND" = "AND",
): { sql: string; params: string[] } {
  const declaration = ctx.windowColumn;
  if (declaration === undefined) throw new Error("query window declaration was not resolved");
  if (!ctx.since || declaration === null) return { sql: "", params: [] };
  if (Array.isArray(declaration) && !declaration.includes(col)) return { sql: "", params: [] };
  return { sql: ` ${keyword} ${col} >= ?`, params: [ctx.since] };
}

export const windowLine = (ctx: QueryContext): string => {
  if (ctx.windowColumn === undefined) throw new Error("query window declaration was not resolved");
  return ctx.since && ctx.windowColumn !== null ? `since ${ctx.since.slice(0, 10)}` : "all time";
};

export function scalar(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as [])) as { n: number } | null;
  return row?.n ?? 0;
}

export function table(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as [])) as Record<string, unknown>[];
}

export function toRows(records: Record<string, unknown>[], columns: string[]): (string | number | null)[][] {
  return records.map((r) => columns.map((c) => (r[c] ?? null) as string | number | null));
}

export const CLAUDE_EDITS =
  "an edit is matched by the `Edit` and `Write` tool names, and Codex writes a `FileChange`";

export const CLAUDE_STOPS =
  "a stop is read from fields only Claude writes on a message, and Codex marks an interrupted turn " +
  "instead, which `dim q turns` reports";

export const claudeOnly = (...bases: string[]): string =>
  `These counts are Claude's alone: ${bases.join("; ")}. A Codex session is absent from them rather than idle.`;

export const stoppedByOwner = (prefix = "m."): string =>
  `(${prefix}denial_kind = 'user-rejected' OR ${prefix}interrupted_message_id IS NOT NULL ` +
  `OR ${prefix}user_feedback IS NOT NULL)`;

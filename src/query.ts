import type { Database } from "bun:sqlite";
import { UsageError } from "./cli-contract";

export type QueryResult = {
  denominator: string;
  columns: string[];
  rows: (string | number | null)[][];
  note?: string;
};

export type QueryContext = {
  arg?: string;
  home: string;
};

export type Query = {
  name: string;
  summary: string;
  usage: string;
  run: (db: Database, ctx: QueryContext) => QueryResult;
};

export function requiredArg(ctx: QueryContext, usage: string): string {
  if (!ctx.arg?.trim()) throw new UsageError(`usage: ${usage}`);
  return ctx.arg;
}

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

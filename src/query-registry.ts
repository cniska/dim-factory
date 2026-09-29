import type { Query } from "./query";
import { priorArt } from "./query-code";
import { factory, order } from "./query-factory";
import { search } from "./query-search";
import { running, thread } from "./query-session";

export const QUERIES: Query[] = [priorArt, search, thread, factory, order, running];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}

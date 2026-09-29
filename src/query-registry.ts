import type { Query } from "./query";
import { factory, order } from "./query-factory";
import { priorArt } from "./query-prior-art";
import { search } from "./query-search";
import { thread } from "./query-thread";

export const QUERIES: Query[] = [priorArt, search, thread, factory, order];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}

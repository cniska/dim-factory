import type { Query } from "./query";
import { convention, exemplars, fixes, priorArt, stale } from "./query-code";
import { candidates, corrections, repeats, rework } from "./query-correction";
import {
  factory,
  factoryAnalytics,
  findings,
  order,
  scheduleHistory,
  schedules,
  slices,
} from "./query-factory";
import { keywords, search } from "./query-search";
import { chain, delegation, digest, resume, running, session, sessions, thread } from "./query-session";
import { skill, skills, tools } from "./query-skill";
import { burn, cost, models, tokens, turns } from "./query-usage";

const withDeclaredWindow = (query: Query): Query => ({
  ...query,
  run: (db, ctx) => query.run(db, { ...ctx, windowColumn: query.window }),
});

export const QUERIES: Query[] = [
  convention,
  priorArt,
  chain,
  slices,
  digest,
  stale,
  search,
  keywords,
  thread,
  factory,
  schedules,
  scheduleHistory,
  factoryAnalytics,
  order,
  skill,
  resume,
  delegation,
  running,
  fixes,
  exemplars,
  repeats,
  burn,
  tokens,
  models,
  cost,
  turns,
  tools,
  skills,
  corrections,
  findings,
  candidates,
  rework,
  sessions,
  session,
].map(withDeclaredWindow);

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}

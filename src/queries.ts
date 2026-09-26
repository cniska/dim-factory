import { convention, exemplars, fixes, priorArt, stale } from "./code-queries";
import { candidates, corrections, repeats, rework } from "./correction-queries";
import {
  factory,
  factoryAnalytics,
  findings,
  order,
  scheduleHistory,
  schedules,
  slices,
} from "./factory-queries";
import type { Query } from "./query";
import { keywords, search } from "./search-queries";
import { chain, delegation, digest, resume, running, session, sessions, thread } from "./session-queries";
import { skill, skills, tools } from "./skill-queries";
import { burn, cost, models, tokens, turns } from "./usage-queries";

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

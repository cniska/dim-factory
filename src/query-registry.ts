import type { Query } from "./query";
import { convention, exemplars, fixes, priorArt, stale } from "./query-code";
import { corrections, repeats, rework } from "./query-correction";
import { factory, findings, order } from "./query-factory";
import { search } from "./query-search";
import { chain, resume, running, session, sessions, thread } from "./query-session";
import { skill, skills, tools } from "./query-skill";
import { burn } from "./query-usage";

export const QUERIES: Query[] = [
  convention,
  priorArt,
  chain,
  stale,
  search,
  thread,
  factory,
  order,
  skill,
  resume,
  running,
  fixes,
  exemplars,
  repeats,
  burn,
  tools,
  skills,
  corrections,
  findings,
  rework,
  sessions,
  session,
];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}

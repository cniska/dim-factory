import type { Database } from "bun:sqlite";
import type { BenchQuestion } from "./bench-corpus";
import { ndcgAtK, recallAtK } from "./bench-rank-metrics";
import type { QueryContext } from "./query";
import { findQuery } from "./query-registry";
import { readDistilled } from "./search-distilled";
import type { Question } from "./search-embed";
import { type PassageRef, parsePassageRef } from "./search-passage-ref";

const REF_COLUMN = "ref";

const PRINTED_REF = 8;

function distilled(db: Database): { messages: Set<string>; sessions: Set<string> } {
  const messages = new Set(readDistilled(db, null).map((item) => item.ref));
  const holder = db.prepare<{ session_id: string }, [string]>("SELECT session_id FROM message WHERE id = ?");
  const sessions = new Set<string>();
  for (const id of messages) {
    const row = holder.get(id);
    if (row) sessions.add(row.session_id);
  }
  return { messages, sessions };
}

function refusal(db: Database, ref: string, known: ReturnType<typeof distilled>): string | undefined {
  const { id, at } = parsePassageRef(ref);
  const count = (sql: string, params: string[]): number =>
    db.prepare<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
  if (at === undefined) {
    if (count("SELECT count(*) AS n FROM repo_commit WHERE sha = ?", [id]) > 0) return undefined;
    if (count("SELECT count(*) AS n FROM session WHERE id = ?", [id]) === 0) {
      return `${ref} names no commit and no session`;
    }
    if (!known.sessions.has(id)) {
      return `${ref} names a session holding nothing anyone distilled, which no query returns`;
    }
    return undefined;
  }
  if (count("SELECT count(*) AS n FROM session WHERE id = ?", [id]) === 0) {
    return `${ref} names no session; a passage is graded as <session>@<timestamp>`;
  }
  const named = db
    .prepare<{ id: string }, [string, string]>("SELECT id FROM message WHERE session_id = ? AND ts = ?")
    .all(id, at)
    .map((row) => row.id);
  if (named.length === 0) {
    return `${ref} names no message in that session; a passage carries the whole timestamp search prints`;
  }
  if (!named.some((messageId) => known.messages.has(messageId))) {
    return `${ref} names a turn nobody distilled, which no query returns`;
  }
  return undefined;
}

const grades = (labeled: PassageRef, printed: PassageRef): boolean =>
  labeled.id.startsWith(printed.id) && (labeled.at === undefined || labeled.at === printed.at);

function inseparable(a: PassageRef, b: PassageRef): boolean {
  const [x, y] = [a.id.slice(0, PRINTED_REF), b.id.slice(0, PRINTED_REF)];
  return (x.startsWith(y) || y.startsWith(x)) && (a.at === undefined || b.at === undefined || a.at === b.at);
}

export type QuestionScore = {
  id: string;
  query: string;
  returned: number;
  graded: number;
  recall: number;
  ndcg: number;
};

export type BenchReport = {
  k: number;
  scores: QuestionScore[];
  recall: number;
  ndcg: number;
  capped: number;
  unscorable: { id: string; why: string }[];
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

export async function runBench(
  db: Database,
  questions: BenchQuestion[],
  k: number,
  ctx: QueryContext,
  embed: (text: string) => Promise<Question | undefined>,
): Promise<BenchReport> {
  const scores: QuestionScore[] = [];
  const unscorable: { id: string; why: string }[] = [];
  const known = distilled(db);
  for (const asked of questions) {
    const query = findQuery(asked.query);
    if (!query) {
      unscorable.push({ id: asked.id, why: `no query named ${asked.query}` });
      continue;
    }
    const question = query.embedsArg ? await embed(asked.question) : undefined;
    const result = query.run(db, { ...ctx, arg: asked.question, question });
    const refColumn = result.columns.indexOf(REF_COLUMN);
    if (refColumn === -1) {
      const why = result.path
        ? `${asked.query} answered on its ${result.path} path, which prints no ${REF_COLUMN} column`
        : `${asked.query} prints no ${REF_COLUMN} column to score against`;
      unscorable.push({ id: asked.id, why });
      continue;
    }
    const labeled = [...asked.relevant.keys()];
    const refused = labeled.map((ref) => refusal(db, ref, known)).filter((why) => why !== undefined);
    if (refused.length > 0) {
      unscorable.push({ id: asked.id, why: refused.join("; ") });
      continue;
    }
    const refs = labeled.map((ref) => ({ ref, parsed: parsePassageRef(ref) }));
    const clash = refs.some((a, i) => refs.slice(i + 1).some((b) => inseparable(a.parsed, b.parsed)));
    if (clash) {
      unscorable.push({
        id: asked.id,
        why: "two graded rows print the same ref, so one cannot be told from the other",
      });
      continue;
    }
    const retrieved = result.rows.map((row) => {
      const printed = String(row[refColumn]);
      const returned = parsePassageRef(printed);
      return refs.find(({ parsed }) => grades(parsed, returned))?.ref ?? printed;
    });
    scores.push({
      id: asked.id,
      query: asked.query,
      returned: result.rows.length,
      graded: asked.relevant.size,
      recall: recallAtK(retrieved, new Set(asked.relevant.keys()), k),
      ndcg: ndcgAtK(retrieved, asked.relevant, k),
    });
  }
  return {
    k,
    scores,
    recall: mean(scores.map((s) => s.recall)),
    ndcg: mean(scores.map((s) => s.ndcg)),
    capped: scores.filter((s) => s.returned < k).length,
    unscorable,
  };
}

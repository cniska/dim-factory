import type { Database } from "bun:sqlite";
import type { BenchQuestion } from "./bench-corpus";
import { readDistilled } from "./distilled";
import type { Question } from "./embed";
import { type PassageRef, parsePassageRef } from "./passage-ref";
import { findQuery, type QueryContext } from "./queries";
import { ndcgAtK, recallAtK } from "./rank-metrics";

/** Where a scored question's answer is read from the rows a query returned. */
const REF_COLUMN = "ref";

/** How much of an id a query prints, which is the width a label is matched at. */
const PRINTED_REF = 8;

/**
 * Which messages a passage ref may name. Read from the sources a passage is
 * distilled from rather than from the vectors built over them, so a label is
 * checked without the runner consulting the index it is scoring.
 */
function distilledMessages(db: Database): Set<string> {
  return new Set(readDistilled(db, null).map((item) => item.ref));
}

/** Why a labeled ref cannot be scored, or undefined where the record holds it. */
function refusal(db: Database, ref: string, distilled: Set<string>): string | undefined {
  const { id, at } = parsePassageRef(ref);
  const count = (sql: string, params: string[]): number =>
    db.prepare<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
  if (at === undefined) {
    if (count("SELECT count(*) AS n FROM repo_commit WHERE sha = ?", [id]) > 0) return undefined;
    if (count("SELECT count(*) AS n FROM session WHERE id = ?", [id]) > 0) return undefined;
    return `${ref} names no commit and no session`;
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
  // An ordinary turn is addressable and is never a hit, so grading one scores
  // zero for ever — the same mistake as grading a message by its own id, and the
  // easier one to make, since `keywords` and `thread` print a time for any turn.
  if (!named.some((messageId) => distilled.has(messageId))) {
    return `${ref} names a turn nobody distilled, which no query returns`;
  }
  return undefined;
}

/**
 * Whether a labeled ref grades the row a query printed. An id is matched at the
 * printed width because a corpus stores the whole one, and a ref naming only a
 * session grades every passage in it — the question asked of a session as a whole.
 */
const grades = (labeled: PassageRef, printed: PassageRef): boolean =>
  labeled.id.startsWith(printed.id) && (labeled.at === undefined || labeled.at === printed.at);

/** Whether one printed row could answer to both labels, leaving them inseparable. */
function inseparable(a: PassageRef, b: PassageRef): boolean {
  const [x, y] = [a.id.slice(0, PRINTED_REF), b.id.slice(0, PRINTED_REF)];
  return (x.startsWith(y) || y.startsWith(x)) && (a.at === undefined || b.at === undefined || a.at === b.at);
}

export type QuestionScore = {
  id: string;
  query: string;
  returned: number;
  /**
   * How many rows the question grades. Recall divides by all of them while
   * nDCG compares against the best k, so the two disagree whenever a question
   * grades more rows than the cutoff — without this the reader cannot tell
   * that from a ranking that put one of them out of reach.
   */
  graded: number;
  recall: number;
  ndcg: number;
};

export type BenchReport = {
  k: number;
  scores: QuestionScore[];
  recall: number;
  ndcg: number;
  /** How many questions the query answered with fewer rows than the cutoff asked for. */
  capped: number;
  /** A question the corpus holds and nothing could score, with the reason. */
  unscorable: { id: string; why: string }[];
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Scores the corpus against the queries as they are, by running them. Nothing
 * here reaches into the index: a ranking is only better if it is better through
 * the door an agent uses.
 *
 * A query whose rows carry no ref cannot be scored at all — `keywords` prints a
 * session and a timestamp, which name a message to a reader but identify none to
 * a program. Such a question is reported as unscorable rather than skipped, so a
 * corpus cannot quietly measure less than it claims.
 */
export async function runBench(
  db: Database,
  questions: BenchQuestion[],
  k: number,
  ctx: QueryContext,
  embed: (text: string) => Promise<Question | undefined>,
): Promise<BenchReport> {
  const scores: QuestionScore[] = [];
  const unscorable: { id: string; why: string }[] = [];
  const distilled = distilledMessages(db);
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
      // A query that degraded prints the fallback's columns, so blaming its
      // shape would send the reader to the wrong place entirely.
      const why = result.path
        ? `${asked.query} answered on its ${result.path} path, which prints no ${REF_COLUMN} column`
        : `${asked.query} prints no ${REF_COLUMN} column to score against`;
      unscorable.push({ id: asked.id, why });
      continue;
    }
    // A query prints an id short enough to read, so a returned row names its
    // answer by a prefix of the id the corpus stores. Which entity a ref names is
    // the query's choice, not the corpus's: `search` prints the sha for a commit
    // and `<session>@<timestamp>` for a message. A label naming anything else can
    // never match, and would read as a ranking failure forever.
    const labeled = [...asked.relevant.keys()];
    const refused = labeled.map((ref) => refusal(db, ref, distilled)).filter((why) => why !== undefined);
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

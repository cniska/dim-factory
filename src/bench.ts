import type { Database } from "bun:sqlite";
import type { BenchQuestion } from "./bench-corpus";
import type { Question } from "./embed";
import { findQuery, type QueryContext } from "./queries";
import { ndcgAtK, recallAtK } from "./rank-metrics";

/** Where a scored question's answer is read from the rows a query returned. */
const REF_COLUMN = "ref";

/** How much of a ref a query prints, which is the width a label is matched at. */
const PRINTED_REF = 8;

/**
 * Whether a labeled ref names anything this record holds. A corpus is graded by
 * hand against output, so the usual mistake is grading a message by its own id
 * when the query printed the session — which scores zero and reads as a miss.
 */
function knownRefs(db: Database, refs: string[]): Map<string, boolean> {
  const commit = db.prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM repo_commit WHERE sha = ?");
  const session = db.prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM session WHERE id = ?");
  return new Map(refs.map((ref) => [ref, (commit.get(ref)?.n ?? 0) > 0 || (session.get(ref)?.n ?? 0) > 0]));
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
  const names = knownRefs(
    db,
    questions.flatMap((q) => [...q.relevant.keys()]),
  );
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
    // A query prints a ref short enough to read, so a returned row names its
    // answer by a prefix of the ref the corpus stores. Which entity that ref
    // names is the query's choice, not the corpus's: `search` prints the sha for
    // a commit and the session for a message, because a session is what the
    // reader goes on to ask `thread` about. A label naming anything else can
    // never match, and would read as a ranking failure forever.
    const labeled = [...asked.relevant.keys()];
    const unknown = labeled.filter((ref) => !names.get(ref));
    if (unknown.length > 0) {
      unscorable.push({
        id: asked.id,
        why: `${unknown.join(", ")} names no commit and no session; a message is graded by the session ${asked.query} prints`,
      });
      continue;
    }
    const prefixes = new Set(labeled.map((ref) => ref.slice(0, PRINTED_REF)));
    if (prefixes.size < labeled.length) {
      unscorable.push({
        id: asked.id,
        why: "two graded rows print the same ref, so one cannot be told from the other",
      });
      continue;
    }
    const retrieved = result.rows.map((row) => {
      const printed = String(row[refColumn]);
      return labeled.find((ref) => ref.startsWith(printed)) ?? printed;
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

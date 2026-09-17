import { join } from "node:path";
import { dataDir, type Env } from "./paths";
import { findQuery } from "./queries";

/**
 * A question with the rows known to answer it, which is what turns "this ranks
 * better" into a number. One JSON object per line, so a question can be added,
 * regraded or removed in a diff a person can read.
 *
 * The file sits beside the database rather than in this repo: a question that
 * measures anything names the owner's own work — a branch, a product, a pull
 * request — and this repo is public.
 */
export type BenchQuestion = {
  id: string;
  /** The named query this question is asked of, so a corpus can score more than one. */
  query: string;
  question: string;
  /** Ref to grade, where a higher grade is a better answer and zero is not an answer. */
  relevant: Map<string, number>;
};

export function corpusPath(env: Env = process.env): string {
  return join(dataDir(env), "retrieval.jsonl");
}

// A function declaration rather than a const, so its `never` narrows what the
// caller checked and the reader is not handed a cast on every field.
function refuse(line: number, why: string): never {
  throw new Error(`corpus line ${line}: ${why}`);
}

/** A field is read through this or not at all, so a wrong type refuses like a wrong value. */
function asText(value: unknown, line: number, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) refuse(line, `${what} is not text`);
  return value;
}

/**
 * Every refusal names the line, including one whose field is the wrong type: a
 * corpus is written and regraded by hand, and an id left unquoted is the kind of
 * mistake a complaint with no line number sends its editor hunting for.
 */
export function parseCorpus(text: string): BenchQuestion[] {
  const questions: BenchQuestion[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      refuse(line, "not JSON");
    }
    if (typeof parsed !== "object" || parsed === null) refuse(line, "not an object");
    const { id, query, question, relevant } = parsed as Record<string, unknown>;
    const at = asText(id, line, "id");
    if (seen.has(at)) refuse(line, `${at} is already asked above; a question is scored once`);
    const asked = asText(question, line, "question");
    const named = asText(query, line, "query");
    if (!findQuery(named)) refuse(line, `${named} is not a query this asks`);
    if (!Array.isArray(relevant) || relevant.length === 0) {
      refuse(line, "needs at least one relevant row");
    }
    const grades = new Map<string, number>();
    for (const row of relevant as Record<string, unknown>[]) {
      const ref = asText(row?.ref, line, "a relevant row's ref");
      if (grades.has(ref)) refuse(line, `${ref} is graded twice, so one grading is discarded`);
      const { grade } = row;
      if (typeof grade !== "number" || !Number.isFinite(grade) || grade <= 0) {
        refuse(line, `${ref} needs a grade above zero; a row that answers nothing is left out`);
      }
      grades.set(ref, grade);
    }
    seen.add(at);
    questions.push({ id: at, query: named, question: asked, relevant: grades });
  });
  return questions;
}

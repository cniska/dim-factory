import type { Database } from "bun:sqlite";
import { checkoutRoot } from "./checkout";
import { labelFor } from "./git-remote";

export type Answer = "fixed" | "refused";

export type Finding = {
  repo: string;
  slice: string;
  dimension: string;
  file: string | null;
  summary: string;
  answer: Answer;
  reason: string | null;
};

export class FindingError extends Error {}

const FLAGS = ["--slice", "--dimension", "--answer", "--summary", "--file", "--why"] as const;
type Flag = (typeof FLAGS)[number];

/**
 * A flag given twice is refused rather than resolved to either value: the caller
 * is an agent assembling a command from a reviewer's output, and a summary that
 * silently lost half of itself reads as a reviewer that said less than it did.
 */
export function parseFinding(args: string[]): Map<Flag, string> {
  const given = new Map<Flag, string>();
  for (let at = 0; at < args.length; at += 1) {
    const flag = FLAGS.find((f) => f === args[at]);
    if (!flag) throw new FindingError(`dim finding: ${args[at]} is not one of ${FLAGS.join(", ")}`);
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--"))
      throw new FindingError(`dim finding: ${flag} needs a value`);
    if (given.has(flag)) throw new FindingError(`dim finding: ${flag} given twice`);
    given.set(flag, value);
    at += 1;
  }
  return given;
}

/**
 * Where the finding is recorded is the checkout the builder is standing in, and a
 * directory that is no checkout, or a checkout with no remote, is refused: the
 * row's whole use is joining to commit_file by repo and path, and a row labeled
 * with a guess joins to the wrong history or to none.
 */
function repoAt(dir: string): string {
  const root = checkoutRoot(dir);
  if (!root) throw new FindingError(`dim finding: ${dir} is not inside a checkout`);
  const label = labelFor(root);
  if (!label) throw new FindingError(`dim finding: ${root} has no origin or upstream remote to name it`);
  return label;
}

export function findingFrom(args: string[], dir: string): Finding {
  const given = parseFinding(args);
  for (const flag of ["--slice", "--dimension", "--answer", "--summary"] as const) {
    if (!given.has(flag)) throw new FindingError(`dim finding: ${flag} is required`);
  }
  const answer = given.get("--answer");
  if (answer !== "fixed" && answer !== "refused") {
    throw new FindingError(`dim finding: --answer is fixed or refused, not ${answer}`);
  }
  const reason = given.get("--why") ?? null;
  // The same rule the table holds, said where the caller can read it: a
  // constraint violation names a column and not what the loop wanted.
  if (answer === "refused" && (reason === null || reason.trim() === "")) {
    throw new FindingError("dim finding: a refused finding needs --why, which is what ends it");
  }
  if (answer === "fixed" && reason !== null) {
    throw new FindingError("dim finding: --why states a refusal, so it does not belong on a fix");
  }
  return {
    repo: repoAt(dir),
    slice: given.get("--slice") as string,
    dimension: given.get("--dimension") as string,
    file: given.get("--file") ?? null,
    summary: given.get("--summary") as string,
    answer,
    reason,
  };
}

export function recordFinding(db: Database, finding: Finding): void {
  db.run(
    `INSERT INTO finding (repo, slice, dimension, file, summary, answer, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    [
      finding.repo,
      finding.slice,
      finding.dimension,
      finding.file,
      finding.summary,
      finding.answer,
      finding.reason,
    ],
  );
}

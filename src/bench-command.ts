import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { runBench } from "./bench";
import { corpusPath, parseCorpus } from "./bench-corpus";
import { type Command, UsageError } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import { embedQuestion } from "./search-embed";

const DEFAULT_CUTOFF = 10;

function cutoff(args: string[]): number {
  const at = args.indexOf("--k");
  if (at === -1) return DEFAULT_CUTOFF;
  const given = args[at + 1];
  const k = Number(given);
  if (!Number.isInteger(k) || k < 1) {
    throw new UsageError(
      given === undefined
        ? "--k takes a whole number above zero"
        : `--k takes a whole number above zero, not ${given}`,
    );
  }
  return k;
}

export const benchCommand: Command = {
  name: "bench",
  usage: "usage: dim bench [--k <n>]",
  summary:
    "score retrieval against the questions in retrieval.jsonl beside the database (--k for the cutoff, default 10)",
  async run(args) {
    const path = corpusPath();
    if (!existsSync(path))
      return { corpus: path, questions: 0, next: "a question is a line of JSON; docs/design.md says which" };
    const questions = parseCorpus(await readFile(path, "utf8"));
    const k = cutoff(args);
    const db = openReadOnly(dbPath());
    try {
      const report = await runBench(db, questions, k, { home: resolveHomeDir() }, embedQuestion);
      return { corpus: path, questions: questions.length, ...report };
    } finally {
      db.close();
    }
  },
};

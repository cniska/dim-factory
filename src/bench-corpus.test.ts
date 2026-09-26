import { describe, expect, test } from "bun:test";
import { corpusPath, parseCorpus } from "./bench-corpus";

const LINE = JSON.stringify({
  id: "q-repetition",
  query: "search",
  question: "what does the owner end up saying more than once",
  relevant: [{ ref: "8f11bbf9", grade: 3 }],
});

describe("the corpus a ranking is scored against", () => {
  test("reads a question and the rows that answer it", () => {
    const [question] = parseCorpus(LINE);
    expect(question?.id).toBe("q-repetition");
    expect(question?.query).toBe("search");
    expect(question?.relevant.get("8f11bbf9")).toBe(3);
  });

  test("ignores blank lines, so a file can be grouped", () => {
    expect(parseCorpus(`\n${LINE}\n\n`)).toHaveLength(1);
  });

  test("names the line it could not read", () => {
    expect(() => parseCorpus(`${LINE}\nnot json`)).toThrow("line 2");
  });

  test("refuses a question no query answers", () => {
    const bad = JSON.stringify({ ...JSON.parse(LINE), query: "telepathy" });
    expect(() => parseCorpus(bad)).toThrow("telepathy");
  });

  test("refuses a question nothing answers", () => {
    const none = JSON.stringify({ ...JSON.parse(LINE), relevant: [] });
    expect(() => parseCorpus(none)).toThrow("at least one relevant row");
    const zero = JSON.stringify({ ...JSON.parse(LINE), relevant: [{ ref: "x", grade: 0 }] });
    expect(() => parseCorpus(zero)).toThrow("above zero");
  });

  test("refuses a question with no id, rather than scoring it under none", () => {
    const { id, ...rest } = JSON.parse(LINE);
    expect(() => parseCorpus(JSON.stringify(rest))).toThrow("id is not text");
  });

  test("refuses a relevant row with no ref, which nothing retrieved can match", () => {
    const noRef = JSON.stringify({ ...JSON.parse(LINE), relevant: [{ grade: 3 }] });
    expect(() => parseCorpus(noRef)).toThrow("ref is not text");
  });

  test("refuses a grade that is missing, negative, or not a number", () => {
    const relevant = (grade: unknown) =>
      JSON.stringify({ ...JSON.parse(LINE), relevant: [{ ref: "r", grade }] });
    expect(() => parseCorpus(relevant(undefined))).toThrow("needs a grade above zero");
    expect(() => parseCorpus(relevant(-5))).toThrow("needs a grade above zero");
    expect(() => parseCorpus(relevant("5"))).toThrow("needs a grade above zero");
  });

  test("refuses one ref graded twice, rather than discarding a grading", () => {
    const twice = JSON.stringify({
      ...JSON.parse(LINE),
      relevant: [
        { ref: "r", grade: 3 },
        { ref: "r", grade: 1 },
      ],
    });
    expect(() => parseCorpus(twice)).toThrow("graded twice");
  });

  test("names the line even where a field is the wrong type", () => {
    const numericId = JSON.stringify({ ...JSON.parse(LINE), id: 5 });
    expect(() => parseCorpus(`${LINE}\n${numericId}`)).toThrow("line 2");
    expect(() => parseCorpus(`${LINE}\nnull`)).toThrow("line 2");
  });

  test("refuses two questions under one id, which would score twice", () => {
    expect(() => parseCorpus(`${LINE}\n${LINE}`)).toThrow("q-repetition");
  });

  test("refuses a question with nothing to ask", () => {
    const empty = JSON.stringify({ ...JSON.parse(LINE), question: "  " });
    expect(() => parseCorpus(empty)).toThrow("line 1");
  });
});

describe("where the corpus lives", () => {
  test("sits in the data directory, not the checkout", () => {
    expect(corpusPath({ DIM_HOME: "/scratch" })).toBe("/scratch/retrieval.jsonl");
  });
});

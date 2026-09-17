/**
 * How a retrieval change is judged, so that "this ranks better" is a number and
 * not a preference. Both are standard information-retrieval measures; the
 * definitions are pinned here rather than imported so a corpus scored today can
 * be compared with one scored a year from now.
 *
 * A question nothing can answer is a defect in the corpus rather than a score of
 * zero, because zero is also what a total miss earns and an aggregate cannot
 * separate the two afterwards. Both measures refuse it where the caller can see.
 */

/** First position wins: a row returned twice is one row, found once. */
const firstOccurrences = (retrieved: string[], k: number): string[] => [...new Set(retrieved)].slice(0, k);

/** The share of a question's relevant rows that came back in the first k. */
export function recallAtK(retrieved: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) throw new Error("recall@k needs a question with at least one relevant row");
  return firstOccurrences(retrieved, k).filter((ref) => relevant.has(ref)).length / relevant.size;
}

const discounted = (grade: number, position: number): number => grade / Math.log2(position + 2);

/**
 * Gain discounted by how far down the list a row sat, over the gain of the best
 * possible order of the same grades. Counting hits cannot see a ranking change
 * that returns the same rows in a worse order, which is most of them.
 */
export function ndcgAtK(retrieved: string[], grades: ReadonlyMap<string, number>, k: number): number {
  const best = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, position) => sum + discounted(grade, position), 0);
  if (best === 0) throw new Error("nDCG@k needs a question with at least one row graded above zero");
  const gain = firstOccurrences(retrieved, k).reduce(
    (sum, ref, position) => sum + discounted(grades.get(ref) ?? 0, position),
    0,
  );
  return gain / best;
}

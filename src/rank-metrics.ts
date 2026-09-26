function window(retrieved: string[], k: number): (string | null)[] {
  const seen = new Set<string>();
  return retrieved.slice(0, k).map((ref) => {
    if (seen.has(ref)) return null;
    seen.add(ref);
    return ref;
  });
}

export function recallAtK(retrieved: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) throw new Error("recall@k needs a question with at least one relevant row");
  const found = window(retrieved, k).filter((ref) => ref !== null && relevant.has(ref));
  return found.length / relevant.size;
}

const discounted = (grade: number, position: number): number => grade / Math.log2(position + 2);

export function ndcgAtK(retrieved: string[], grades: ReadonlyMap<string, number>, k: number): number {
  const best = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, position) => sum + discounted(grade, position), 0);
  if (best === 0) throw new Error("nDCG@k needs a question with at least one row graded above zero");
  const gain = window(retrieved, k).reduce(
    (sum, ref, position) => sum + discounted((ref === null ? 0 : grades.get(ref)) ?? 0, position),
    0,
  );
  return gain / best;
}

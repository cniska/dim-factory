export type PlanSlice = {
  title: string;
  outcome: string;
};

export type PlanArtifact = {
  body: string;
  slices: readonly PlanSlice[];
};

export function parsePlanArtifact(raw: string): PlanArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("planner output must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("planner output must be a JSON object");
  }
  const artifact = value as { body?: unknown; slices?: unknown };
  if (typeof artifact.body !== "string" || artifact.body.trim() === "") {
    throw new Error("planner output must contain a non-empty body");
  }
  if (!Array.isArray(artifact.slices) || artifact.slices.length === 0) {
    throw new Error("planner output must contain at least one slice");
  }
  const slices = artifact.slices.map((slice, index) => {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
      throw new Error(`planner slice ${index + 1} must be an object`);
    }
    const item = slice as { title?: unknown; outcome?: unknown };
    if (typeof item.title !== "string" || item.title.trim() === "") {
      throw new Error(`planner slice ${index + 1} must contain a non-empty title`);
    }
    if (typeof item.outcome !== "string" || item.outcome.trim() === "") {
      throw new Error(`planner slice ${index + 1} must contain a non-empty outcome`);
    }
    return { title: item.title.trim(), outcome: item.outcome.trim() };
  });
  return { body: artifact.body.trim(), slices };
}

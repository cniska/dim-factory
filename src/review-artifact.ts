export type ReviewFinding = {
  dimension: string;
  summary: string;
};

export type ReviewArtifact = {
  body: string;
  findings: ReviewFinding[];
};

export function parseReviewArtifact(raw: string): ReviewArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("reviewer output must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reviewer output must be a JSON object");
  }
  const artifact = value as { body?: unknown; findings?: unknown };
  if (typeof artifact.body !== "string" || artifact.body.trim() === "") {
    throw new Error("reviewer output must contain a non-empty body");
  }
  if (!Array.isArray(artifact.findings)) {
    throw new Error("reviewer output must contain a findings array");
  }
  const findings = artifact.findings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`reviewer finding ${index + 1} must be an object`);
    }
    const item = finding as { dimension?: unknown; summary?: unknown };
    if (typeof item.dimension !== "string" || item.dimension.trim() === "") {
      throw new Error(`reviewer finding ${index + 1} must contain a non-empty dimension`);
    }
    if (typeof item.summary !== "string" || item.summary.trim() === "") {
      throw new Error(`reviewer finding ${index + 1} must contain a non-empty summary`);
    }
    return { dimension: item.dimension.trim(), summary: item.summary.trim() };
  });
  return { body: artifact.body.trim(), findings };
}

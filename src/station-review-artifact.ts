export const REVIEW_DIMENSIONS = [
  "plan",
  "correctness",
  "tests",
  "architecture",
  "maintainability",
  "docs",
  "security",
  "performance",
  "style",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const SEVERITIES = ["critical", "high", "medium"] as const;
export type Severity = (typeof SEVERITIES)[number];

const CONFORMANCE_KINDS = ["missing", "extra", "misunderstood"] as const;
const COVERAGE_STATUSES = ["clean", "findings", "not_applicable", "not_run"] as const;
const MAX_OBSERVATIONS = 3;

export type ReviewFinding = {
  dimension: ReviewDimension;
  file: string;
  line: number;
  failure: string;
  fix: string;
  severity: Severity;
};

export type ReviewReport = {
  verdict: string;
  findings: ReviewFinding[];
  conformance: { kind: (typeof CONFORMANCE_KINDS)[number]; slice: string | null; detail: string }[];
  coverage: {
    dimension: ReviewDimension;
    status: (typeof COVERAGE_STATUSES)[number];
    reason: string | null;
  }[];
  setAside: { item: string; why: string }[];
  unverified: { claim: string; wouldSettle: string }[];
  observations: string[];
};

type Fields = Record<string, unknown>;

function object(value: unknown, what: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`);
  return value as Fields;
}

function list(fields: Fields, key: string): unknown[] {
  const value = fields[key];
  if (!Array.isArray(value)) throw new Error(`reviewer output must contain a ${key} array`);
  return value;
}

function text(fields: Fields, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${what} must contain a non-empty ${key}`);
  return value.trim();
}

function optionalText(fields: Fields, key: string, what: string): string | null {
  const value = fields[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${what} must give ${key} as a string or null`);
  return value.trim() === "" ? null : value.trim();
}

function oneOf<T extends string>(fields: Fields, key: string, values: readonly T[], what: string): T {
  const value = fields[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${what} has ${key} ${JSON.stringify(value)}, which is not one of ${values.join(", ")}`);
  }
  return value as T;
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  const what = `reviewer finding ${index + 1}`;
  const fields = object(value, what);
  const severity = fields.severity;
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as Severity)) {
    throw new Error(
      `${what} has severity ${JSON.stringify(severity)}; every finding blocks at critical, high or medium, ` +
        "and a point that does not block belongs in observations",
    );
  }
  const line = fields.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error(`${what} must give line as a whole number from 1`);
  }
  return {
    dimension: oneOf(fields, "dimension", REVIEW_DIMENSIONS, what),
    file: text(fields, "file", what),
    line,
    failure: text(fields, "failure", what),
    fix: text(fields, "fix", what),
    severity: severity as Severity,
  };
}

function parseCoverage(values: unknown[], findingDimensions: Set<string>): ReviewReport["coverage"] {
  const coverage = values.map((value, index) => {
    const what = `reviewer coverage ${index + 1}`;
    const fields = object(value, what);
    const dimension = oneOf(fields, "dimension", REVIEW_DIMENSIONS, what);
    const status = oneOf(fields, "status", COVERAGE_STATUSES, what);
    const reason = optionalText(fields, "reason", what);
    if ((status === "not_applicable" || status === "not_run") && reason === null) {
      throw new Error(`reviewer coverage of ${dimension} is ${status} and must give a reason`);
    }
    if ((status === "findings") !== findingDimensions.has(dimension)) {
      throw new Error(
        findingDimensions.has(dimension)
          ? `reviewer coverage of ${dimension} is ${status}, but a finding carries ${dimension}`
          : `reviewer coverage of ${dimension} is findings, but no finding carries ${dimension}`,
      );
    }
    return { dimension, status, reason };
  });
  for (const dimension of REVIEW_DIMENSIONS) {
    const entries = coverage.filter((entry) => entry.dimension === dimension).length;
    if (entries !== 1) {
      throw new Error(`reviewer coverage must hold exactly one entry for ${dimension}, and holds ${entries}`);
    }
  }
  return coverage;
}

export function parseReviewReport(raw: string): ReviewReport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("reviewer output must be valid JSON");
  }
  const fields = object(value, "reviewer output");
  const verdict = text(fields, "verdict", "reviewer output");
  const findings = list(fields, "findings").map(parseFinding);
  const conformance = list(fields, "conformance").map((entry, index) => {
    const what = `reviewer conformance ${index + 1}`;
    const item = object(entry, what);
    return {
      kind: oneOf(item, "kind", CONFORMANCE_KINDS, what),
      slice: optionalText(item, "slice", what),
      detail: text(item, "detail", what),
    };
  });
  const coverage = parseCoverage(
    list(fields, "coverage"),
    new Set(findings.map((finding) => finding.dimension)),
  );
  const setAside = list(fields, "set_aside").map((entry, index) => {
    const what = `reviewer set_aside ${index + 1}`;
    const item = object(entry, what);
    return { item: text(item, "item", what), why: text(item, "why", what) };
  });
  const unverified = list(fields, "unverified").map((entry, index) => {
    const what = `reviewer unverified ${index + 1}`;
    const item = object(entry, what);
    return { claim: text(item, "claim", what), wouldSettle: text(item, "would_settle", what) };
  });
  const observations = list(fields, "observations").map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`reviewer observation ${index + 1} must be a non-empty string`);
    }
    return entry.trim();
  });
  if (observations.length > MAX_OBSERVATIONS) {
    throw new Error(
      `reviewer output holds ${observations.length} observations, and at most ${MAX_OBSERVATIONS} are kept`,
    );
  }
  return { verdict, findings, conformance, coverage, setAside, unverified, observations };
}

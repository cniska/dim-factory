import type { HarnessScript, HarnessTurn } from "./harness-script";
import type { Finding, ReviewArtifact, Slice } from "./worker-acts";

const AREAS = [
  "conformance",
  "correctness",
  "tests",
  "architecture",
  "maintainability",
  "docs",
  "security",
  "performance",
  "style",
] as const;

export const SLICES: readonly Slice[] = [
  { title: "Write the greeting", outcome: "greeting.txt holds the greeting." },
  { title: "Link it from the README", outcome: "The README names greeting.txt." },
];

export const BUILD_ARTIFACT =
  "## Outcome\n\nThe README links a greeting.\n\n## Verification\n\nThe check passed on both slices.";

export const REVIEW_ARTIFACT: ReviewArtifact = {
  body: "## Outcome\n\nThe diff does what the Build artifact says.",
  covered: AREAS,
  setAside: [],
  unverified: [],
};

export const planTurn = (
  slices: readonly Slice[] = SLICES,
  body = "## Outcome\n\nA greeting the README links to.",
): HarnessTurn => [{ act: "plan", body, slices }];

export const sliceActs = (n: number): HarnessTurn => [
  { act: "write", path: `slice-${n}.txt`, content: `slice ${n}\n` },
  { act: "commit", subject: `feat: add slice ${n}` },
];

export const buildTurn = (slices = SLICES.length, artifact = BUILD_ARTIFACT): HarnessTurn => [
  ...Array.from({ length: slices }, (_, i) => sliceActs(i + 1)).flat(),
  { act: "build-return", artifact },
];

export const reviewTurn = (): HarnessTurn => [{ act: "review-return", artifact: REVIEW_ARTIFACT }];

export const findingsTurn = (findings: readonly Finding[]): HarnessTurn => [{ act: "findings", findings }];

export const finding = (fields: Partial<Finding> = {}): Finding => ({
  area: "maintainability",
  file: "slice-1.txt",
  line: 1,
  failure: "The greeting repeats the file name.",
  fix: "Say hello instead.",
  severity: "medium",
  ...fields,
});

export const happyPath = (): HarnessScript => ({
  planner: [planTurn()],
  builder: [buildTurn()],
  reviewer: [reviewTurn()],
});

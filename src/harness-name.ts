export const HARNESSES = ["codex"] as const;
export type HarnessName = (typeof HARNESSES)[number];

export function parseHarness(value: string | undefined): HarnessName {
  if (value && (HARNESSES as readonly string[]).includes(value)) return value as HarnessName;
  throw new Error(`${value ?? "harness"}: unsupported harness; supported harnesses: ${HARNESSES.join(", ")}`);
}

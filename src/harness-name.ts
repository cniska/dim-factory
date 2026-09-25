export const DEFAULT_HARNESS = "codex" as const;
// Adding one needs a schema version bump: `factory_order_worker.harness` checks against this list.
export const HARNESSES = [DEFAULT_HARNESS, "claude"] as const;
export type HarnessName = (typeof HARNESSES)[number];
export const HARNESSES_SQL = HARNESSES.map((harness) => `'${harness}'`).join(",");

export function isHarness(value: string | undefined): value is HarnessName {
  return value !== undefined && (HARNESSES as readonly string[]).includes(value);
}

export function parseHarness(
  value: string | undefined,
  fail: (message: string) => Error = (message) => new Error(message),
): HarnessName {
  if (isHarness(value)) return value;
  throw fail(`${value ?? "harness"}: unsupported harness; supported harnesses: ${HARNESSES.join(", ")}`);
}

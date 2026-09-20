/**
 * What a station's work needs, named for the work rather than for any harness's
 * flag. A station declares a set of these and the spawn profile turns the set
 * into one harness's argv, which is what keeps a brief harness-neutral.
 */
export type Capability =
  | "read-files"
  | "edit-files"
  | "read-history"
  | "ask-dim"
  | "raise-finding"
  | "run-check";

export const CAPABILITIES: readonly Capability[] = [
  "read-files",
  "edit-files",
  "read-history",
  "ask-dim",
  "raise-finding",
  "run-check",
];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

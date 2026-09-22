/**
 * What a station's work needs, named for the work rather than for any harness's
 * flag. A station declares a set of these and the selected harness adapter
 * turns the set into harness-specific capability controls.
 */
export type Capability =
  | "bootstrap-worker"
  | "read-files"
  | "edit-files"
  | "read-history"
  | "ask-dim"
  | "raise-finding"
  | "run-check";

export const CAPABILITIES: readonly Capability[] = [
  "bootstrap-worker",
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

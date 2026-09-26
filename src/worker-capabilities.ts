export type Capability =
  | "bootstrap-worker"
  | "read-files"
  | "edit-files"
  | "read-history"
  | "ask-dim"
  | "run-check";

export const CAPABILITIES: readonly Capability[] = [
  "bootstrap-worker",
  "read-files",
  "edit-files",
  "read-history",
  "ask-dim",
  "run-check",
];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

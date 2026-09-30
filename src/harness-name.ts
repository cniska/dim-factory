export const HARNESSES = ["codex", "claude"] as const;
export type HarnessName = (typeof HARNESSES)[number];

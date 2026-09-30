export const HARNESSES = ["codex", "claude", "grok"] as const;
export type HarnessName = (typeof HARNESSES)[number];

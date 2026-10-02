export const TOOLS = ["claude", "codex", "grok", "pi", "omp"] as const;

export type Tool = (typeof TOOLS)[number];

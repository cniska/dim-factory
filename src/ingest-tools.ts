export type Tool = "claude" | "codex" | "grok" | "pi" | "omp";

export const TOOLS: readonly Tool[] = ["claude", "codex", "grok", "pi", "omp"];

export const TOOLS_SQL = TOOLS.map((tool) => `'${tool}'`).join(",");

export type Tool = "claude" | "codex" | "grok";

export const TOOLS: readonly Tool[] = ["claude", "codex", "grok"];

export const TOOLS_SQL = TOOLS.map((tool) => `'${tool}'`).join(",");

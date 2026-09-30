export type Tool = "claude" | "codex";

export const TOOLS: readonly Tool[] = ["claude", "codex"];

export const TOOLS_SQL = TOOLS.map((tool) => `'${tool}'`).join(",");

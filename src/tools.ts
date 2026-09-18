/** The agent CLIs this reads. Two, in depth, which `docs/goals.md` states as the goal. */
export type Tool = "claude" | "codex";

export const TOOLS: readonly Tool[] = ["claude", "codex"];

/** Binds at creation only: a table already on disk keeps the CHECK it was born with. */
export const TOOLS_SQL = TOOLS.map((tool) => `'${tool}'`).join(",");

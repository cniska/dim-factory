/** The agent CLIs this reads. Two, in depth, which `docs/goals.md` states as the goal. */
export type Tool = "claude" | "codex";

export const TOOLS: readonly Tool[] = ["claude", "codex"];

/**
 * The tool vocabulary as a SQL literal list, so a column constraining `tool`
 * derives from the same list the code iterates. Spelled twice, they drift in the
 * direction nothing catches: a row the code writes and the database refuses.
 */
export const TOOLS_SQL = TOOLS.map((tool) => `'${tool}'`).join(",");

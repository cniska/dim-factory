/** What a builder hands back at the end of a code turn: the runner commits the worktree under
 *  `subject`, and `artifact` is the Build artifact when the turn finished the last slice. */
export type BuildTurn = { subject: string; artifact: string };

export const BUILD_TURN_SCHEMA = `${import.meta.dir}/build-turn.schema.json`;

export function parseBuildTurn(raw: string): BuildTurn {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("builder output must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("builder output must be a JSON object");
  }
  const turn = value as { subject?: unknown; artifact?: unknown };
  if (typeof turn.subject !== "string" || turn.subject.trim() === "") {
    throw new Error("builder output must contain a non-empty commit subject");
  }
  // A second line would become the commit's body, where a trailer such as Co-authored-by lands
  // under the operator's signature.
  if (/[\r\n]/.test(turn.subject.trim())) {
    throw new Error("builder output's commit subject must be one line");
  }
  if (typeof turn.artifact !== "string") {
    throw new Error("builder output must contain an artifact string");
  }
  return { subject: turn.subject.trim(), artifact: turn.artifact.trim() };
}

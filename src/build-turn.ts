import type { OrderFindingAnswer } from "./order-finding-state";

export type BuildTurn = { subject: string; artifact: string; answers: OrderFindingAnswer[] };

export const BUILD_TURN_SCHEMA = `${import.meta.dir}/build-turn.schema.json`;

function parseAnswer(value: unknown, index: number): OrderFindingAnswer {
  const what = `builder output's answer ${index + 1}`;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`);
  const given = value as { finding?: unknown; answer?: unknown; resolution?: unknown };
  if (typeof given.finding !== "number" || !Number.isInteger(given.finding)) {
    throw new Error(`${what} must name its finding by id`);
  }
  if (given.answer !== "fixed" && given.answer !== "refused") {
    throw new Error(`${what} must be fixed or refused`);
  }
  if (given.resolution !== null && typeof given.resolution !== "string") {
    throw new Error(`${what} must carry a resolution string or null`);
  }
  const resolution = given.resolution?.trim() || null;
  if (given.answer === "refused" && resolution === null) {
    throw new Error(`${what} refuses finding ${given.finding} without saying why in its resolution`);
  }
  return { finding: given.finding, answer: given.answer, resolution };
}

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
  const turn = value as { subject?: unknown; artifact?: unknown; answers?: unknown };
  if (typeof turn.subject !== "string" || turn.subject.trim() === "") {
    throw new Error("builder output must contain a non-empty commit subject");
  }
  if (/[\r\n]/.test(turn.subject.trim())) {
    throw new Error("builder output's commit subject must be one line");
  }
  if (typeof turn.artifact !== "string") {
    throw new Error("builder output must contain an artifact string");
  }
  if (!Array.isArray(turn.answers)) {
    throw new Error("builder output must contain an answers list");
  }
  return {
    subject: turn.subject.trim(),
    artifact: turn.artifact.trim(),
    answers: turn.answers.map(parseAnswer),
  };
}

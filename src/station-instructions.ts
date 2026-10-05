import build from "../prompts/build.md" with { type: "text" };
import plan from "../prompts/plan.md" with { type: "text" };
import artifact from "../prompts/references/artifact.md" with { type: "text" };
import bug from "../prompts/references/bug.md" with { type: "text" };
import qualityAreas from "../prompts/references/quality-areas.md" with { type: "text" };
import review from "../prompts/review.md" with { type: "text" };
import type { Station } from "./order-contract";

const INSTRUCTIONS: Readonly<Record<Station, readonly string[]>> = {
  plan: [plan, bug, artifact],
  build: [build, bug, qualityAreas, artifact],
  review: [review, qualityAreas, bug, artifact],
};

export function stationInstructions(station: Station): string {
  return INSTRUCTIONS[station].join("\n");
}

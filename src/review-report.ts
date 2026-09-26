import type { Database } from "bun:sqlite";
import { findingLocation } from "./finding-location";
import { type FindingStanding, orderFindingStandings, owesAnswer } from "./order-finding-state";
import type { ReviewReport } from "./review-artifact";

function location(finding: FindingStanding): string {
  const where = findingLocation(finding);
  return where === null ? "no location recorded" : `\`${where}\``;
}

function section(heading: string, lines: string[]): string {
  return [`## ${heading}`, "", ...(lines.length > 0 ? lines : ["None."])].join("\n");
}

/** Read off the whole order rather than this round, since an earlier finding still open or a
 *  refusal still contested holds the order however clean this round's reading was. */
function verdict(standings: readonly FindingStanding[]): string {
  const states = standings.map((finding) => finding.state);
  if (states.includes("open")) return "Returns to the builder.";
  if (states.includes("awaiting_owner")) return "Held for an owner ruling.";
  return "May advance.";
}

/**
 * The owner's Review artifact, rendered from the round's recorded findings and rulings and the
 * reviewer's report. The order of sections is the order the owner decides in.
 */
export function renderReviewReport(db: Database, reviewId: number, report: ReviewReport): string {
  const orderId = db
    .query<{ order_id: string }, [number]>("SELECT order_id FROM factory_order_review WHERE id = ?")
    .get(reviewId)?.order_id;
  if (!orderId) throw new Error(`no review ${reviewId}`);
  const standings = orderFindingStandings(db, orderId);
  const byId = new Map(standings.map((finding) => [finding.id, finding]));
  const findings = standings.filter((finding) => finding.reviewId === reviewId);
  const rulings = db
    .query<{ finding_id: number; ruling: string; reason: string | null }, [number]>(
      "SELECT finding_id, ruling, reason FROM factory_order_finding_ruling WHERE review_id = ? ORDER BY finding_id",
    )
    .all(reviewId)
    .map((ruling) => ({ ...ruling, finding: byId.get(ruling.finding_id) as FindingStanding }));
  // Every contested refusal still holding the order, whichever round contested it: a later round
  // does not rule on it again, and the owner decides from this artifact.
  const contested = standings.filter((finding) => finding.state === "awaiting_owner");
  // An earlier finding the builder has not answered since its last ruling holds the order as
  // open, and no ruling can name it, since a ruling judges an answer.
  const ruledHere = new Set(rulings.map((ruling) => ruling.finding_id));
  const unanswered = standings.filter(
    (finding) => owesAnswer(finding) && finding.reviewId !== reviewId && !ruledHere.has(finding.id),
  );
  return [
    section("Verdict", [`**${verdict(standings)}** ${report.verdict}`]),
    section(
      "Blocking findings",
      findings.map(
        (finding) =>
          `- **${finding.severity ?? "no severity recorded"}** ${location(finding)} (${finding.dimension}, finding ${finding.id}): ` +
          `${finding.failure}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
      ),
    ),
    section(
      "Owner rulings",
      contested.flatMap((finding) => [
        `- Finding ${finding.id}, ${location(finding)}: ${finding.failure}`,
        `  - Builder's refusal: ${finding.resolution}`,
        `  - Reviewer's reason: ${finding.rulingReason}`,
      ]),
    ),
    section("Earlier findings", [
      ...rulings.map(
        ({ finding, ruling, reason }) =>
          `- Finding ${finding.id}, ${location(finding)}: ${finding.failure} **${ruling}**` +
          `${reason ? `: ${reason}` : ""}`,
      ),
      ...unanswered.map(
        (finding) =>
          `- Finding ${finding.id}, ${location(finding)}: ${finding.failure} **awaiting the builder's answer**`,
      ),
    ]),
    section(
      "Plan conformance",
      report.conformance.map(
        (entry) => `- **${entry.kind}**${entry.slice ? ` (${entry.slice})` : ""}: ${entry.detail}`,
      ),
    ),
    section("Coverage", [
      "| Dimension | Status | Reason |",
      "|---|---|---|",
      ...report.coverage.map((entry) => `| ${entry.dimension} | ${entry.status} | ${entry.reason ?? ""} |`),
    ]),
    section("What was not judged", [
      ...report.setAside.map((entry) => `- Set aside: ${entry.item}. ${entry.why}`),
      ...report.unverified.map(
        (entry) => `- Not verified: ${entry.claim}. Would settle it: ${entry.wouldSettle}`,
      ),
    ]),
    section(
      "Observations",
      report.observations.map((observation) => `- ${observation}`),
    ),
  ].join("\n\n");
}

import type { Database } from "bun:sqlite";
import { displayedAnswer, type FindingStanding, orderFindingStandings } from "./order-finding-state";
import type { ReviewReport } from "./station-review-artifact";

function location(finding: FindingStanding): string {
  return `\`${finding.file}:${finding.line}\``;
}

function section(heading: string, lines: string[]): string {
  return [`## ${heading}`, "", ...(lines.length > 0 ? lines : ["None."])].join("\n");
}

export function renderReviewReport(db: Database, reviewId: number, report: ReviewReport): string {
  const orderId = db
    .query<{ order_id: string }, [number]>("SELECT order_id FROM factory_order_review WHERE id = ?")
    .get(reviewId)?.order_id;
  if (!orderId) throw new Error(`no review ${reviewId}`);
  const standings = orderFindingStandings(db, orderId);
  const findings = standings.filter((finding) => finding.reviewId === reviewId);
  const earlier = standings.filter((finding) => finding.reviewId !== reviewId);
  return [
    section("Verdict", [
      `**${findings.length > 0 ? "Returns to the builder." : "May advance."}** ${report.verdict}`,
    ]),
    section(
      "Blocking findings",
      findings.map(
        (finding) =>
          `- **${finding.severity}** ${location(finding)} (${finding.dimension}, finding ${finding.id}): ` +
          `${finding.failure} Fix: ${finding.fix}`,
      ),
    ),
    section(
      "Earlier findings",
      earlier.map(
        (finding) =>
          `- Finding ${finding.id}, ${location(finding)}: ${finding.failure} **${displayedAnswer(finding)}**` +
          `${finding.resolution ? `: ${finding.resolution}` : ""}`,
      ),
    ),
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

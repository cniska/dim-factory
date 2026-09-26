import type { Database } from "bun:sqlite";
import { orderFindingStandings } from "./order-finding-state";
import type { ReviewReport } from "./review-artifact";

type StoredFinding = {
  id: number;
  dimension: string;
  summary: string;
  file: string | null;
  line: number | null;
  failure: string | null;
  fix: string | null;
  severity: string | null;
  resolution: string | null;
};

type StoredRuling = StoredFinding & { ruling: string; reason: string | null };

const FINDING_COLUMNS =
  "f.id, f.dimension, f.summary, f.file, f.line, f.failure, f.fix, f.severity, f.resolution";

function location(finding: StoredFinding): string {
  if (finding.file === null) return "no location recorded";
  return finding.line === null ? `\`${finding.file}\`` : `\`${finding.file}:${finding.line}\``;
}

function section(heading: string, lines: string[]): string {
  return [`## ${heading}`, "", ...(lines.length > 0 ? lines : ["None."])].join("\n");
}

/** Read off the whole order rather than this round, since an earlier finding still open or a
 *  refusal still contested holds the order however clean this round's reading was. */
function verdict(db: Database, orderId: string): string {
  const states = orderFindingStandings(db, orderId).map((finding) => finding.state);
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
  const findings = db
    .query<StoredFinding, [number]>(
      `SELECT ${FINDING_COLUMNS} FROM factory_order_finding f WHERE f.review_id = ? ORDER BY f.id`,
    )
    .all(reviewId);
  const rulings = db
    .query<StoredRuling, [number]>(
      `SELECT ${FINDING_COLUMNS}, r.ruling, r.reason
       FROM factory_order_finding_ruling r JOIN factory_order_finding f ON f.id = r.finding_id
       WHERE r.review_id = ? ORDER BY f.id`,
    )
    .all(reviewId);
  const standings = orderFindingStandings(db, orderId);
  const awaiting = new Set(standings.filter((f) => f.state === "awaiting_owner").map((f) => f.id));
  // Every contested refusal still holding the order, whichever round contested it: a later round
  // does not rule on it again, and the owner decides from this artifact. A refusal is contested
  // at most once, since after the owner's decision it no longer stands.
  const contested = db
    .query<StoredRuling, [string]>(
      `SELECT ${FINDING_COLUMNS}, r.ruling, r.reason
       FROM factory_order_finding_ruling r JOIN factory_order_finding f ON f.id = r.finding_id
       WHERE f.order_id = ? AND r.ruling = 'refusal_contested' ORDER BY f.id`,
    )
    .all(orderId)
    .filter((ruling) => awaiting.has(ruling.id));
  // An earlier finding the builder has not answered holds the order as open, and no ruling can
  // name it, since a ruling judges an answer.
  const unanswered = db
    .query<StoredFinding, [string, number]>(
      `SELECT ${FINDING_COLUMNS} FROM factory_order_finding f
       WHERE f.order_id = ? AND f.answer IS NULL AND f.review_id <> ? ORDER BY f.id`,
    )
    .all(orderId, reviewId);
  const failure = (finding: StoredFinding) => finding.failure ?? finding.summary;
  return [
    section("Verdict", [`**${verdict(db, orderId)}** ${report.verdict}`]),
    section(
      "Blocking findings",
      findings.map(
        (finding) =>
          `- **${finding.severity ?? "no severity recorded"}** ${location(finding)} (${finding.dimension}, finding ${finding.id}): ` +
          `${failure(finding)}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
      ),
    ),
    section(
      "Owner decisions",
      contested.flatMap((ruling) => [
        `- Finding ${ruling.id}, ${location(ruling)}: ${failure(ruling)}`,
        `  - Builder's refusal: ${ruling.resolution}`,
        `  - Reviewer's reason: ${ruling.reason}`,
      ]),
    ),
    section("Earlier findings", [
      ...rulings.map(
        (ruling) =>
          `- Finding ${ruling.id}, ${location(ruling)}: ${failure(ruling)} **${ruling.ruling}**` +
          `${ruling.reason ? `: ${ruling.reason}` : ""}`,
      ),
      ...unanswered.map(
        (finding) =>
          `- Finding ${finding.id}, ${location(finding)}: ${failure(finding)} **awaiting the builder's answer**`,
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

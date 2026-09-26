import type { Database } from "bun:sqlite";

export const REVIEWER_RULINGS = [
  "addressed",
  "not_addressed",
  "refusal_accepted",
  "refusal_contested",
] as const;
export type ReviewerRuling = (typeof REVIEWER_RULINGS)[number];

export type OwnerRuling = "refusal_upheld" | "refusal_overturned";

export type FindingAnswer = "fixed" | "refused";

export type OrderFindingAnswer = { finding: number; answer: FindingAnswer; resolution: string | null };

export type FindingState = "settled" | "open" | "awaiting_owner";

export type FindingStanding = {
  id: number;
  orderId: string;
  reviewId: number;
  dimension: string;
  file: string | null;
  line: number | null;
  failure: string;
  fix: string | null;
  severity: string | null;
  raisedAt: string;
  answer: FindingAnswer | null;
  resolution: string | null;
  answered: boolean;
  ruling: ReviewerRuling | null;
  rulingReason: string | null;
  ownerRuling: OwnerRuling | null;
  ownerReason: string | null;
  state: FindingState;
  refusalStands: boolean;
};

type Row = {
  id: number;
  order_id: string;
  review_id: number;
  dimension: string;
  file: string | null;
  line: number | null;
  failure: string;
  fix: string | null;
  severity: string | null;
  raised_at: string;
  answer: FindingAnswer | null;
  resolution: string | null;
  answers: number;
  judged: number;
  ruling: ReviewerRuling | null;
  ruling_reason: string | null;
  owner_ruling: OwnerRuling | null;
  owner_reason: string | null;
  latest: ReviewerRuling | OwnerRuling | null;
};

function classify(latest: Row["latest"]): FindingState {
  if (latest === "addressed" || latest === "refusal_accepted" || latest === "refusal_upheld")
    return "settled";
  if (latest === "refusal_contested") return "awaiting_owner";
  return "open";
}

function standing(row: Row): FindingStanding {
  return {
    id: row.id,
    orderId: row.order_id,
    reviewId: row.review_id,
    dimension: row.dimension,
    file: row.file,
    line: row.line,
    failure: row.failure,
    fix: row.fix,
    severity: row.severity,
    raisedAt: row.raised_at,
    answer: row.answer,
    resolution: row.resolution,
    answered: row.answers > row.judged,
    ruling: row.ruling,
    rulingReason: row.ruling_reason,
    ownerRuling: row.owner_ruling,
    ownerReason: row.owner_reason,
    state: classify(row.latest),
    refusalStands: row.answer === "refused" && row.owner_ruling !== "refusal_overturned",
  };
}

const STANDING_SQL = `
  SELECT f.id, f.order_id, f.review_id, f.dimension, f.file, f.line, f.failure, f.fix, f.severity,
         f.raised_at, a.answer, a.resolution,
         (SELECT count(*) FROM factory_order_finding_answer n WHERE n.finding_id = f.id) AS answers,
         (SELECT count(*) FROM factory_order_finding_ruling n
          WHERE n.finding_id = f.id AND n.review_id IS NOT NULL) AS judged,
         r.ruling, r.reason AS ruling_reason, o.ruling AS owner_ruling, o.reason AS owner_reason,
         CASE WHEN o.id > coalesce(r.id, 0) THEN o.ruling ELSE r.ruling END AS latest
  FROM factory_order_finding f
  LEFT JOIN factory_order_finding_answer a
    ON a.id = (SELECT max(n.id) FROM factory_order_finding_answer n WHERE n.finding_id = f.id)
  LEFT JOIN factory_order_finding_ruling r
    ON r.id = (SELECT max(n.id) FROM factory_order_finding_ruling n
               WHERE n.finding_id = f.id AND n.review_id IS NOT NULL)
  LEFT JOIN factory_order_finding_ruling o ON o.finding_id = f.id AND o.review_id IS NULL`;

export function findingStandingsOf(db: Database, orderIds: readonly string[]): FindingStanding[] {
  return db
    .query<Row, [string]>(
      `${STANDING_SQL} WHERE f.order_id IN (SELECT value FROM json_each(?)) ORDER BY f.id`,
    )
    .all(JSON.stringify(orderIds))
    .map(standing);
}

export function orderFindingStandings(db: Database, orderId: string): FindingStanding[] {
  return findingStandingsOf(db, [orderId]);
}

export function findingStanding(db: Database, findingId: number): FindingStanding | null {
  const row = db.query<Row, [number]>(`${STANDING_SQL} WHERE f.id = ?`).get(findingId);
  return row ? standing(row) : null;
}

export function owesAnswer(finding: FindingStanding): boolean {
  return finding.state === "open" && !finding.answered;
}

export function rulingApplies(finding: FindingStanding, ruling: ReviewerRuling): boolean {
  const onRefusal = ruling === "refusal_accepted" || ruling === "refusal_contested";
  return onRefusal === finding.refusalStands;
}

export function displayedAnswer(finding: FindingStanding): FindingAnswer | "unanswered" {
  if (owesAnswer(finding)) return "unanswered";
  if (finding.answer === null) {
    throw new Error(`finding ${finding.id} is ${finding.state} with no answer recorded`);
  }
  return finding.answer;
}

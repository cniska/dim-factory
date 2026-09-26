import type { Database } from "bun:sqlite";

export const FINDING_RULINGS = [
  "addressed",
  "not_addressed",
  "refusal_accepted",
  "refusal_contested",
] as const;
export type FindingRuling = (typeof FINDING_RULINGS)[number];

export type RefusalDecision = "refusal_upheld" | "refusal_overturned";

export type FindingState = "settled" | "open" | "awaiting_owner";

export type FindingStanding = {
  id: number;
  orderId: string;
  reviewId: number;
  answer: "fixed" | "refused" | null;
  ruling: FindingRuling | null;
  decision: RefusalDecision | null;
  state: FindingState;
  /** A refusal the owner has not overturned, which only a `refusal_*` ruling may judge. */
  refusalStands: boolean;
};

type Row = {
  id: number;
  order_id: string;
  review_id: number;
  answer: "fixed" | "refused" | null;
  ruling: FindingRuling | null;
  decision: RefusalDecision | null;
};

// A finding has at most one owner decision, and nothing contests a refusal after it, so the
// latest ruling and the decision are enough to place it without ordering the two tables.
function classify(row: Row): FindingState {
  if (row.decision === "refusal_upheld") return "settled";
  if (row.decision === "refusal_overturned") return row.ruling === "addressed" ? "settled" : "open";
  if (row.ruling === "addressed" || row.ruling === "refusal_accepted") return "settled";
  if (row.ruling === "refusal_contested") return "awaiting_owner";
  return "open";
}

function standing(row: Row): FindingStanding {
  return {
    id: row.id,
    orderId: row.order_id,
    reviewId: row.review_id,
    answer: row.answer,
    ruling: row.ruling,
    decision: row.decision,
    state: classify(row),
    refusalStands: row.answer === "refused" && row.decision !== "refusal_overturned",
  };
}

const STANDING_SQL = `
  SELECT f.id, f.order_id, f.review_id, f.answer,
         (SELECT r.ruling FROM factory_order_finding_ruling r
          WHERE r.finding_id = f.id ORDER BY r.id DESC LIMIT 1) AS ruling,
         (SELECT d.decision FROM factory_order_refusal_decision d WHERE d.finding_id = f.id) AS decision
  FROM factory_order_finding f`;

export function orderFindingStandings(db: Database, orderId: string): FindingStanding[] {
  return db
    .query<Row, [string]>(`${STANDING_SQL} WHERE f.order_id = ? ORDER BY f.id`)
    .all(orderId)
    .map(standing);
}

export function findingStanding(db: Database, findingId: number): FindingStanding | null {
  const row = db.query<Row, [number]>(`${STANDING_SQL} WHERE f.id = ?`).get(findingId);
  return row ? standing(row) : null;
}

/** A standing refusal is judged as a refusal; any other answered finding is judged on whether
 *  the new diff fixed it. */
export function rulingApplies(finding: FindingStanding, ruling: FindingRuling): boolean {
  const onRefusal = ruling === "refusal_accepted" || ruling === "refusal_contested";
  return onRefusal === finding.refusalStands;
}

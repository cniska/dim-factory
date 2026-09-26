import type { Database } from "bun:sqlite";

export type FindingAnswer = "fixed" | "refused";

export type OrderFindingAnswer = { finding: number; answer: FindingAnswer; resolution: string | null };

export type FindingStanding = {
  id: number;
  orderId: string;
  reviewId: number;
  dimension: string;
  file: string;
  line: number;
  failure: string;
  fix: string;
  severity: string;
  raisedAt: string;
  answer: FindingAnswer | null;
  resolution: string | null;
};

type Row = {
  id: number;
  order_id: string;
  review_id: number;
  dimension: string;
  file: string;
  line: number;
  failure: string;
  fix: string;
  severity: string;
  raised_at: string;
  answer: FindingAnswer | null;
  resolution: string | null;
};

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
  };
}

const STANDING_SQL = `
  SELECT f.id, rv.order_id, f.review_id, f.dimension, f.file, f.line, f.failure, f.fix, f.severity,
         f.raised_at, a.answer, a.resolution
  FROM factory_order_finding f
  JOIN factory_order_review rv ON rv.id = f.review_id
  LEFT JOIN factory_order_finding_answer a ON a.finding_id = f.id`;

export function findingStandingsOf(db: Database, orderIds: readonly string[]): FindingStanding[] {
  return db
    .query<Row, [string]>(
      `${STANDING_SQL} WHERE rv.order_id IN (SELECT value FROM json_each(?)) ORDER BY f.id`,
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
  return finding.answer === null;
}

export function displayedAnswer(finding: FindingStanding): FindingAnswer | "unanswered" {
  return finding.answer ?? "unanswered";
}

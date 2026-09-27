import type { Database } from "bun:sqlite";
import { type Attempt, startAttempt } from "./order-attempt";
import { appendOrderEventInTransaction } from "./order-ledger";

export function startStationAttempt(db: Database, orderId: string, attempt: Attempt, at: string): void {
  db.transaction(() => {
    startAttempt(db, orderId, attempt, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      {
        kind: "station_started",
        worker: attempt.worker,
        station: attempt.station,
        sessionId: attempt.sessionId,
      },
      at,
    );
  })();
}

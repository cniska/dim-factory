import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeTransaction } from "./db";
import { claimPathLock } from "./db-lock";
import { type Attempt, startAttempt } from "./order-attempt";
import { appendOrderEventInTransaction } from "./order-ledger";
import { dataDir, type Env } from "./paths";

type OrderHold = { release(): void; [Symbol.dispose](): void };

export function holdOrder(orderId: string, env?: Env): OrderHold {
  const release = claimPathLock(join(dataDir(env), `lock-order-${orderId}`));
  return { release, [Symbol.dispose]: release };
}

export function startStationAttempt(db: Database, orderId: string, attempt: Attempt, at: string): void {
  writeTransaction(db, () => {
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
  });
}

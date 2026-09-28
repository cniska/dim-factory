import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { assertOperator } from "./factory-operator";
import { latestArtifact } from "./order-artifacts";
import { assertNoRunningAttempt } from "./order-attempt";
import { appendOrderEvent, appendOrderEventInTransaction, now } from "./order-ledger";
import { assertNext } from "./order-state";
import type { Station } from "./station";

function artifactOf(db: Database, orderId: string, station: Station) {
  const artifact = latestArtifact(db, orderId, station);
  if (!artifact) throw new Error(`order ${orderId} has no ${station} artifact`);
  return artifact;
}

export function approveOrder(
  db: Database,
  orderId: string,
  worker: string,
  reason: string | undefined,
  at = now(),
): Station {
  assertOperator(db, worker, "approve an artifact");
  const { station } = assertNext(db, orderId, "approve");
  const artifact = artifactOf(db, orderId, station);
  if (station === "build" && !reason?.trim()) throw new Error("build approval reason must not be empty");
  appendOrderEvent(db, orderId, { kind: "artifact_approved", worker, artifactId: artifact.id, reason }, at);
  return station;
}

export function returnOrder(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  to?: Station,
  at = now(),
): Station[] {
  assertOperator(db, worker, "return an artifact");
  if (reason.trim() === "") throw new Error("return reason must not be empty");
  const state = assertNext(db, orderId, "return", to);
  const destination = to ?? state.station;
  assertNoRunningAttempt(db, orderId, `return to ${destination}`);
  const returned = [...new Set([...(state.next === "approve" ? [state.station] : []), destination])];
  const artifacts = returned.map((station) => ({ station, artifact: artifactOf(db, orderId, station) }));
  writeTransaction(db, () => {
    for (const { station, artifact } of artifacts) {
      appendOrderEventInTransaction(
        db,
        orderId,
        { kind: "artifact_returned", worker, station, artifactId: artifact.id, reason },
        at,
      );
    }
  });
  return returned;
}

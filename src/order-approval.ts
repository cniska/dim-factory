import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import { latestArtifact } from "./order-artifacts";
import { appendOrderEvent, now } from "./order-ledger";
import { assertNext } from "./order-state";
import type { Station } from "./station";

function awaitingArtifact(db: Database, orderId: string, act: "approve" | "return") {
  const { station } = assertNext(db, orderId, act);
  const artifact = latestArtifact(db, orderId, station);
  if (!artifact) throw new Error(`order ${orderId} has no ${station} artifact`);
  return { station, artifact };
}

export function approveOrder(
  db: Database,
  orderId: string,
  worker: string,
  reason: string | undefined,
  at = now(),
): Station {
  assertOperator(db, worker, "approve an artifact");
  const { station, artifact } = awaitingArtifact(db, orderId, "approve");
  if (station === "build" && !reason?.trim()) throw new Error("build approval reason must not be empty");
  appendOrderEvent(db, orderId, { kind: "artifact_approved", worker, artifactId: artifact.id, reason }, at);
  return station;
}

export function returnOrderArtifact(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): Station {
  assertOperator(db, worker, "return an artifact");
  if (reason.trim() === "") throw new Error("artifact return reason must not be empty");
  const { station, artifact } = awaitingArtifact(db, orderId, "return");
  appendOrderEvent(
    db,
    orderId,
    { kind: "artifact_returned", worker, station, artifactId: artifact.id, reason },
    at,
  );
  return station;
}

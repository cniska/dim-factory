import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { admitAct } from "./order";
import { latestArtifact } from "./order-artifacts";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import type { Station } from "./station-contract";

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
  return writeTransaction(db, () => {
    const { station } = admitAct(db, orderId, "approve", worker);
    const artifact = artifactOf(db, orderId, station);
    if (station === "build" && !reason?.trim()) throw new Error("build approval reason must not be empty");
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "artifact_approved", worker, artifactId: artifact.id, reason },
      at,
    );
    return station;
  });
}

export function returnOrder(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  to?: Station,
  at = now(),
): Station[] {
  if (reason.trim() === "") throw new Error("return reason must not be empty");
  return writeTransaction(db, () => {
    const state = admitAct(db, orderId, "return", worker, to);
    const destination = to ?? state.station;
    const returned = [...new Set([...(state.next === "approve" ? [state.station] : []), destination])];
    const artifacts = returned.map((station) => ({ station, artifact: artifactOf(db, orderId, station) }));
    for (const { station, artifact } of artifacts) {
      appendOrderEventInTransaction(
        db,
        orderId,
        { kind: "artifact_returned", worker, station, artifactId: artifact.id, reason },
        at,
      );
    }
    return returned;
  });
}

import type { Database } from "bun:sqlite";
import type { HarnessName } from "./harness-name";
import { boundStationHarness, type OrderStationName, releaseStationWorker } from "./station-worker";

export type HarnessLimit = { harness: HarnessName; resetsAt: string | null };

export class HarnessesLimited extends Error {
  readonly code = "harnesses_limited";
  constructor(readonly limits: readonly HarnessLimit[]) {
    super(
      `every harness is at its usage limit: ${limits
        .map(
          (limit) => `${limit.harness} ${limit.resetsAt ? `until ${limit.resetsAt}` : "with no reset given"}`,
        )
        .join(", ")}`,
    );
  }
}

type LatestAttempt = { kind: string; outcome: string; resets_at: string | null };

function harnessLimit(db: Database, harness: HarnessName, now: string): HarnessLimit | null {
  const latest = db
    .query<LatestAttempt, [HarnessName]>(
      "SELECT kind, outcome, resets_at FROM factory_order_attempt WHERE harness = ? ORDER BY id DESC LIMIT 1",
    )
    .get(harness);
  if (latest?.kind !== "finished" || latest.outcome !== "limited") return null;
  if (latest.resets_at !== null && latest.resets_at <= now) return null;
  return { harness, resetsAt: latest.resets_at };
}

export function harnessWithCapacity(
  db: Database,
  candidates: readonly HarnessName[],
  now: string,
): HarnessName {
  const limits: HarnessLimit[] = [];
  for (const harness of candidates) {
    const limit = harnessLimit(db, harness, now);
    if (!limit) return harness;
    limits.push(limit);
  }
  throw new HarnessesLimited(limits);
}

function endedLimited(db: Database, orderId: string, harness: HarnessName): boolean {
  const latest = db
    .query<LatestAttempt & { harness: string | null }, [string]>(
      "SELECT kind, outcome, resets_at, harness FROM factory_order_attempt WHERE order_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(orderId);
  return latest?.kind === "finished" && latest.outcome === "limited" && latest.harness === harness;
}

export async function onHarnessWithCapacity<T>(
  db: Database,
  orderId: string,
  station: OrderStationName,
  candidates: readonly HarnessName[],
  named: HarnessName | null,
  run: (harness: HarnessName) => Promise<T>,
): Promise<T> {
  if (named) return run(named);
  const bound = boundStationHarness(db, orderId, station);
  const ordered = [...new Set([...(bound ? [bound] : []), ...candidates])];
  const tried = new Set<HarnessName>();
  for (;;) {
    const harness = harnessWithCapacity(
      db,
      ordered.filter((candidate) => !tried.has(candidate)),
      new Date().toISOString(),
    );
    if (boundStationHarness(db, orderId, station) !== harness) releaseStationWorker(db, orderId, station);
    tried.add(harness);
    try {
      return await run(harness);
    } catch (error) {
      if (!endedLimited(db, orderId, harness)) throw error;
    }
  }
}

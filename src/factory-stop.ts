import type { Database } from "bun:sqlite";

export type FactoryStop = {
  id: number;
  reason: string;
  pulledBy: string;
  pulledAt: string;
  orderId?: string;
};

export type FactoryStopCode =
  | "usage"
  | "reason_missing"
  | "already_live"
  | "none_live"
  | "floor_stopped"
  | "order_held";

export class FactoryStopError extends Error {
  constructor(
    readonly code: FactoryStopCode,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_PULLER = "operator";

const now = (): string => new Date().toISOString();

type Row = {
  id: number;
  reason: string;
  pulled_by: string;
  pulled_at: string;
  order_id: string | null;
};

function stopFrom(row: Row): FactoryStop {
  return {
    id: row.id,
    reason: row.reason,
    pulledBy: row.pulled_by,
    pulledAt: row.pulled_at,
    orderId: row.order_id ?? undefined,
  };
}

export function liveStop(db: Database): FactoryStop | undefined {
  const row = db
    .query<Row, []>(
      `SELECT id, reason, pulled_by, pulled_at, order_id FROM factory_stop WHERE cleared_at IS NULL`,
    )
    .get();
  return row ? stopFrom(row) : undefined;
}

export function pullStop(
  db: Database,
  stop: { reason: string; by?: string; orderId?: string },
  at = now(),
): FactoryStop {
  if (stop.reason.trim() === "") {
    throw new FactoryStopError("reason_missing", "a stop says why, or the next operator clears it blind");
  }
  const by = stop.by ?? DEFAULT_PULLER;
  return db.transaction(() => {
    const live = liveStop(db);
    if (live) {
      throw new FactoryStopError(
        "already_live",
        `the factory is already stopped: ${live.reason} (${live.pulledBy}, ${live.pulledAt})`,
      );
    }
    const result = db.run(
      "INSERT INTO factory_stop (reason, pulled_by, pulled_at, order_id) VALUES (?, ?, ?, ?)",
      [stop.reason, by, at, stop.orderId ?? null],
    );
    return {
      id: Number(result.lastInsertRowid),
      reason: stop.reason,
      pulledBy: by,
      pulledAt: at,
      orderId: stop.orderId,
    };
  })();
}

export function clearStop(db: Database, by = DEFAULT_PULLER, at = now()): FactoryStop {
  return db.transaction(() => {
    const live = liveStop(db);
    if (!live) throw new FactoryStopError("none_live", "the factory is not stopped");
    db.run("UPDATE factory_stop SET cleared_at = ?, cleared_by = ? WHERE id = ?", [at, by, live.id]);
    return live;
  })();
}

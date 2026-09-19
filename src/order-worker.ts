import type { Database } from "bun:sqlite";
import { EVENT_MARK } from "./order-command";

export type OrderWorkerReport = { attributed: number };

/**
 * A `dim order` process is told nothing about which agent it runs as, so the worker on
 * every moment is joined on afterwards rather than written by the command: the command
 * prints the id of the row it wrote, and the harness records that stdout beside its own
 * agent id. The join key is therefore a row id this database minted, which no worker can
 * name for another and none can state about itself.
 *
 * A root session has no agent id of its own, so its writes attribute to the session.
 */
export function attributeOrderEvents(db: Database): OrderWorkerReport {
  const written = db
    .prepare(
      `WITH printed AS (
       SELECT json_extract(payload, '$.tool_use_id') AS tool_use_id,
              json_extract(payload, '$.agent_id') AS agent_id,
              session_id,
              CAST(substr(json_extract(payload, '$.tool_response.stdout'),
                          instr(json_extract(payload, '$.tool_response.stdout'), $mark)
                            + length($mark)) AS INTEGER) AS event_id
         FROM hook_event
        WHERE event = 'post_tool_use'
          AND instr(coalesce(json_extract(payload, '$.tool_response.stdout'), ''), $mark) > 0
          AND json_extract(payload, '$.tool_use_id') IS NOT NULL
     )
     INSERT OR IGNORE INTO factory_order_event_worker (event_id, worker_id, session_id, tool_use_id)
     SELECT p.event_id, p.agent_id, p.session_id, p.tool_use_id
       FROM printed p
       JOIN factory_order_event e ON e.id = p.event_id
      WHERE p.event_id > 0`,
    )
    .run({ $mark: EVENT_MARK });
  return { attributed: Number(written.changes) };
}

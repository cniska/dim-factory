import { UsageError } from "./cli-contract";
import {
  displayedAnswer,
  findingStandingsOf,
  orderFindingStandings,
  owesAnswer,
} from "./order-finding-state";
import { describeState, orderState } from "./order-state";
import { isTerminalOrderStatus, type OrderStatus, orderStatusSql } from "./order-status";
import { type Query, requiredArg, table, toRows } from "./query";

export const order: Query = {
  name: "order",
  summary: "inspect one factory order report, its events, and evidence",
  usage: "dim q order <order-id>",
  run: (db, ctx) => {
    const arg = requiredArg(ctx, order.usage);
    const found = table(
      db,
      `SELECT o.*, ${orderStatusSql("o.id")} AS status FROM factory_order o WHERE o.id LIKE ? || '%' LIMIT 2`,
      [arg],
    );
    if (found.length > 1) throw new UsageError(`${arg} matches more than one order`);
    const [report] = found;
    if (!report) {
      return { denominator: "", columns: ["id"], rows: [], note: `no order starts with ${arg}` };
    }
    const id = report.id as string;
    const state = isTerminalOrderStatus(report.status as OrderStatus) ? null : orderState(db, id);
    const columns = [
      "section",
      "when",
      "kind",
      "status",
      "next",
      "subject",
      "evidence",
      "line",
      "title",
      "description",
    ];
    const aggregate: Record<string, unknown> = {
      section: "order",
      when: report.updated_at,
      kind: "report",
      status: report.status,
      next: state ? describeState(state) : "(none)",
      subject: `${report.project}/${report.id}`,
      evidence: report.priority,
      line: report.line,
      title: report.title,
      description: report.description,
    };
    const evidence: Record<string, unknown>[] = [
      ...table(
        db,
        `SELECT 'event' AS section, e.ts AS "when", e.kind, '' AS status,
                coalesce(a.kind, e.station, '') AS subject,
                coalesce(e.reason, e.commit_sha, cast(e.check_id AS TEXT),
                         cast(e.finding_id AS TEXT), cast(e.artifact_id AS TEXT),
                         cast(e.review_id AS TEXT), '') AS evidence
         FROM factory_order_event e
         LEFT JOIN factory_order_artifact a ON a.id = e.artifact_id
         WHERE e.order_id = ? ORDER BY e.id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'attempt' AS section, recorded_at AS "when",
                'attempt_' || kind AS kind,
                outcome AS status,
                coalesce(station, '') || ' / ' || worker AS subject,
                run_id || ' | operator=' || coalesce(operator_worker, '(none)') ||
                coalesce(' | ' || reason, '') AS evidence
         FROM factory_order_attempt WHERE order_id = ? ORDER BY id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'artifact' AS section, w.ts AS "when", a.kind,
                cast(a.revision AS TEXT) AS status,
                w.worker || coalesce(' @ ' || a.head_sha, '') AS subject, a.body AS evidence
         FROM factory_order_artifact a
         JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_submitted'
         WHERE a.order_id = ? ORDER BY a.kind, a.revision`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'commit' AS section, recorded_at AS "when",
                CASE WHEN ship_run_id IS NULL THEN 'commit_created' ELSE 'commit_rewritten' END AS kind,
                coalesce('ship run ' || ship_run_id, '') AS status,
                coalesce(retires || ' -> ', '') || sha AS subject, subject AS evidence
         FROM factory_order_commit WHERE order_id = ? ORDER BY id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'ship_run' AS section, recorded_at AS "when", 'ship_run' AS kind,
                outcome || CASE patch_equal WHEN 1 THEN ' patch_equal' WHEN 0 THEN ' patch_changed' ELSE '' END
                  AS status,
                'run ' || id || ' at ' || head AS subject,
                concat_ws(' | ', code, reason, 'conflict in ' || conflict_paths, 'stopped at ' || stopped_at,
                          'rebased ' || old_base || '..' || old_head || ' onto ' || new_base,
                          'check ' || check_id, 'worktree kept: ' || worktree_kept,
                          'branch kept: ' || branch_kept) AS evidence
         FROM factory_order_ship_run WHERE order_id = ? ORDER BY id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'check' AS section, finished_at AS "when", 'check_ran' AS kind,
                cast(exit_code AS TEXT) AS status, 'check ' || id || ': ' || command || ' at ' || head_sha AS subject,
                result AS evidence
         FROM factory_order_check WHERE order_id = ? ORDER BY id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'proof' AS section, finished_at AS "when", 'proof_ran' AS kind,
                cast(exit_code AS TEXT) AS status,
                command || ' over ' || (SELECT group_concat(value, ', ') FROM json_each(paths)) ||
                  ' on ' || base_sha || ' for ' || head_sha AS subject,
                result AS evidence
         FROM factory_order_proof WHERE order_id = ? ORDER BY id`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'file' AS section, recorded_at AS "when", 'file_changed' AS kind, '' AS status,
                path AS subject,
                coalesce('+' || added, '') || coalesce(' -' || removed, '') AS evidence
         FROM factory_order_file WHERE order_id = ? ORDER BY path`,
        [id],
      ),
      ...orderFindingStandings(db, id).map((finding) => ({
        section: "finding",
        when: finding.raisedAt,
        kind: owesAnswer(finding) ? "finding_raised" : "finding_answered",
        status: displayedAnswer(finding),
        subject: finding.dimension,
        evidence: finding.failure,
      })),
      ...table(
        db,
        `SELECT 'environment' AS section, recorded_at AS "when", 'environment_reported' AS kind,
                coalesce(cast(exit_code AS TEXT), signal, '') AS status, phase AS subject,
                resources AS evidence
         FROM factory_order_environment WHERE order_id = ? ORDER BY id`,
        [id],
      ),
    ]
      .sort((a, b) => String(a.when).localeCompare(String(b.when)))
      .reverse();
    const rows = [aggregate, ...evidence];
    return {
      denominator: `order ${id}: ${report.status}; one aggregate, ${rows.length - 1} lifecycle and evidence rows`,
      columns,
      rows: toRows(rows, columns),
      note: "Evidence is recorded by the order; this query does not infer completion from repository history.",
    };
  },
};

export const factory: Query = {
  name: "factory",
  summary: "show current factory item and order status with lifecycle and evidence",
  usage: "dim q factory",
  run: (db, ctx) => {
    if (ctx.arg !== undefined)
      throw new UsageError(`usage: ${factory.usage}; dim q order <order-id> reads one order`);
    const orders = table(
      db,
      `SELECT o.project AS project, o.id AS order_id, o.priority, ${orderStatusSql("o.id")} AS status,
              (SELECT e.kind FROM factory_order_event e
               WHERE e.order_id = o.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS latest_event,
              (SELECT e.ts FROM factory_order_event e
               WHERE e.order_id = o.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS latest_event_at,
              coalesce((SELECT c.sha || ' ' || c.subject FROM factory_order_commit c
                        WHERE c.order_id = o.id ORDER BY c.id DESC LIMIT 1), '(none recorded)') AS "commit",
              coalesce((SELECT c.command || ' (' || c.exit_code || ', ' || c.result || ')'
                        FROM factory_order_check c WHERE c.order_id = o.id
                        ORDER BY c.id DESC LIMIT 1), '(none recorded)') AS "check"
       FROM factory_order o
       ORDER BY o.updated_at DESC, o.id`,
    );
    const findings = new Map<string, string[]>();
    for (const finding of findingStandingsOf(
      db,
      orders.map((row) => String(row.order_id)),
    )) {
      const listed = findings.get(finding.orderId) ?? [];
      listed.push(`${finding.dimension}: ${displayedAnswer(finding)} - ${finding.failure}`);
      findings.set(finding.orderId, listed);
    }
    const found = orders.map((row) => {
      const state = isTerminalOrderStatus(row.status as OrderStatus)
        ? null
        : orderState(db, String(row.order_id));
      return {
        ...row,
        next: state ? describeState(state) : "(none)",
        findings: findings.get(String(row.order_id))?.join("; ") ?? "(none recorded)",
      };
    });
    const columns = [
      "project",
      "order_id",
      "priority",
      "status",
      "latest_event",
      "latest_event_at",
      "next",
      "commit",
      "check",
      "findings",
    ];
    return {
      denominator: `${found.length} factory order${found.length === 1 ? "" : "s"} read from factory_order`,
      columns,
      rows: toRows(found, columns),
      note: "Lifecycle and evidence are read from factory_order and its normalized evidence tables; no status is inferred from repository files.",
    };
  },
};

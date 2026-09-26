import { isScratchRepo } from "./ingest-scratch";
import {
  displayedAnswer,
  findingStandingsOf,
  orderFindingStandings,
  owesAnswer,
} from "./order-finding-state";
import { type Query, scalar, table, toRows, window, windowLine } from "./query";

export const findings: Query = {
  name: "findings",
  summary: "what a checking agent raised on a slice, and how each was answered",
  usage: "dim q findings [repo-fragment]",
  spansHistory: true,
  window: "recorded_at",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["dimension", "raised", "fixed", "refused", "slices", "repos"];
    const where: string[] = [];
    const params: string[] = [];
    const w = window("recorded_at", ctx, "WHERE");
    if (w.sql) {
      where.push(w.sql.trim().replace(/^WHERE /, ""));
      params.push(...w.params);
    }
    if (arg) {
      where.push("repo LIKE '%' || ? || '%'");
      params.push(arg);
    }
    const sql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const records = table(
      db,
      `SELECT dimension,
              count(*) AS raised,
              sum(answer = 'fixed') AS fixed,
              sum(answer = 'refused') AS refused,
              count(DISTINCT slice) AS slices,
              count(DISTINCT repo) AS repos
       FROM finding${sql}
       GROUP BY dimension ORDER BY raised DESC, dimension`,
      params,
    );
    const raised = scalar(db, `SELECT count(*) AS n FROM finding${sql}`, ...params);
    const slices = scalar(db, `SELECT count(DISTINCT slice) AS n FROM finding${sql}`, ...params);
    if (raised === 0) {
      return {
        denominator:
          (arg ? `no finding recorded against a repo matching ${arg}` : "no finding has been recorded") +
          (ctx.since ? ` ${windowLine(ctx)}` : ""),
        columns,
        rows: [],
        note: "`dim-station-build` records one per finding as it is answered; nothing backfills a session that has ended.",
      };
    }
    return {
      denominator: `${raised} findings answered across ${slices} ${slices === 1 ? "slice" : "slices"} (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        "This grades the reviewer and never the builder: a builder scored down by a count writes duller " +
        "slices and a reviewer scored up by one invents findings. A refusal ends a finding as completely " +
        "as a fix does, so the two columns are answers and not a pass rate.",
    };
  },
};

export const order: Query = {
  name: "order",
  summary: "inspect one factory order report, its events, and evidence",
  usage: "dim q order <order-id>",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q order <order-id>"]] };
    }
    const found = table(db, "SELECT * FROM factory_order WHERE id LIKE ? || '%' LIMIT 2", [arg]);
    if (found.length === 0) {
      return { denominator: "", columns: ["id"], rows: [], note: `no order starts with ${arg}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["id"], rows: [], note: `${arg} matches more than one order` };
    }
    const report = found[0] as Record<string, unknown>;
    const id = report.id as string;
    const columns = ["section", "when", "kind", "status", "subject", "evidence"];
    const aggregate: Record<string, unknown> = {
      section: "order",
      when: report.updated_at,
      kind: "report",
      status: report.status,
      subject: `${report.project}/${report.id}`,
      evidence: [report.priority, report.hold, report.station, report.stop_reason]
        .filter(Boolean)
        .join(" | "),
    };
    const evidence: Record<string, unknown>[] = [
      ...table(
        db,
        `SELECT 'event' AS section, e.ts AS "when", e.kind, coalesce(e.status, '') AS status,
                coalesce(a.kind, e.station, '') AS subject,
                coalesce(e.reason, e.hold_type,
                         json_extract(e.evidence, '$.from') || ' -> ' || e.commit_sha,
                         e.commit_sha, cast(e.check_id AS TEXT),
                         cast(e.finding_id AS TEXT), cast(e.artifact_id AS TEXT),
                         cast(e.review_id AS TEXT), '') AS evidence
         FROM factory_order_event e
         LEFT JOIN factory_order_artifact a ON a.id = e.artifact_id
         WHERE e.order_id = ?`,
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
         JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
         WHERE a.order_id = ? ORDER BY a.kind, a.revision`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'commit' AS section, c.recorded_at AS "when", e.kind, '' AS status,
                c.sha AS subject, coalesce(c.subject, '') AS evidence
         FROM factory_order_commit c
         JOIN factory_order_event e
           ON e.order_id = c.order_id AND e.commit_sha = c.sha
          AND e.kind IN ('commit_created', 'commit_rewritten')
         WHERE c.order_id = ?`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'rewrite' AS section, recorded_at AS "when", 'rebased_at_ship' AS kind,
                CASE patch_equal WHEN 1 THEN 'patch_equal' ELSE 'patch_changed' END AS status,
                old_base || '..' || old_head || ' -> ' || new_base || '..' || new_head AS subject,
                'check ' || check_id || ' | ' || worker AS evidence
         FROM factory_order_rewrite WHERE order_id = ?`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'check' AS section, finished_at AS "when", 'check_finished' AS kind,
                cast(exit_code AS TEXT) AS status, command AS subject, coalesce(result, '') AS evidence
         FROM factory_order_check WHERE order_id = ?`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'file' AS section, recorded_at AS "when", 'file_changed' AS kind, '' AS status,
                path AS subject,
                coalesce('+' || added, '') || coalesce(' -' || removed, '') AS evidence
         FROM factory_order_file WHERE order_id = ?`,
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
        `SELECT 'document' AS section, recorded_at AS "when", 'document_updated' AS kind, '' AS status,
                path AS subject, '' AS evidence
         FROM factory_order_document WHERE order_id = ?`,
        [id],
      ),
      ...table(
        db,
        `SELECT 'environment' AS section, recorded_at AS "when", 'environment_reported' AS kind,
                coalesce(cast(exit_code AS TEXT), signal, '') AS status, phase AS subject,
                resources AS evidence
         FROM factory_order_environment WHERE order_id = ?`,
        [id],
      ),
    ].sort((a, b) => String(a.when).localeCompare(String(b.when)));
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
  usage: "dim q factory [order-id]",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    const filter = arg ? "WHERE o.id LIKE ? || '%'" : "";
    const orders = table(
      db,
      `SELECT o.project AS project, o.id AS order_id, o.priority, o.status,
              (SELECT e.kind FROM factory_order_event e
               WHERE e.order_id = o.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS latest_event,
              (SELECT e.ts FROM factory_order_event e
               WHERE e.order_id = o.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS latest_event_at,
              coalesce(o.hold, '(none)') AS hold,
              coalesce(o.station, '(absent)') AS station,
              coalesce((SELECT c.sha || coalesce(' ' || c.subject, '')
                        FROM factory_order_event e
                        JOIN factory_order_commit c ON c.order_id = e.order_id AND c.sha = e.commit_sha
                        WHERE e.order_id = o.id AND e.kind IN ('commit_created', 'commit_rewritten')
                        ORDER BY e.id DESC LIMIT 1), '(none recorded)') AS "commit",
              coalesce((SELECT c.command || ' (' || c.exit_code || ', ' || coalesce(c.result, 'no result') || ')'
                        FROM factory_order_event e
                        JOIN factory_order_check c ON c.order_id = e.order_id AND c.id = e.check_id
                        WHERE e.order_id = o.id AND e.kind = 'check_finished'
                        ORDER BY e.id DESC LIMIT 1), '(none recorded)') AS "check",
              coalesce((SELECT nullif(trim(coalesce(e.hold_type || ': ', '') || coalesce(e.reason, '')), '')
                        FROM factory_order_event e WHERE e.order_id = o.id
                          AND e.kind IN ('completed', 'failed')
                        ORDER BY e.ts DESC, e.id DESC LIMIT 1), '(none)') AS stop
       FROM factory_order o ${filter}
       ORDER BY o.updated_at DESC, o.id`,
      arg ? [arg] : [],
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
    const found = orders.map((row) => ({
      ...row,
      findings: findings.get(String(row.order_id))?.join("; ") ?? "(none recorded)",
    }));
    const columns = [
      "project",
      "order_id",
      "priority",
      "status",
      "latest_event",
      "latest_event_at",
      "hold",
      "station",
      "commit",
      "check",
      "findings",
      "stop",
    ];
    if (found.length === 0) {
      return {
        denominator: "no factory order matched",
        columns,
        rows: [],
        note: arg ? `no order starts with ${arg}` : "no factory orders are recorded",
      };
    }
    return {
      denominator:
        `${found.length} factory order${found.length === 1 ? "" : "s"} read from factory_order; ` +
        "queue planner source absent (no file-backed planner is recorded)",
      columns,
      rows: toRows(found, columns),
      note: "Lifecycle and evidence are read from factory_order and its normalized evidence tables; no status is inferred from repository files.",
    };
  },
};

export const schedules: Query = {
  name: "schedules",
  summary: "show persisted schedules and which enabled schedules are due",
  usage: "dim q schedules",
  spansHistory: true,
  window: null,
  run: (db) => {
    const columns = ["id", "queue", "interval_seconds", "state", "due", "last_evaluated_at", "last_due_at"];
    const at = new Date().toISOString();
    const rows = table(
      db,
      `SELECT id, queue_id AS queue, interval_seconds,
              CASE WHEN enabled = 0 THEN 'disabled' WHEN paused = 1 THEN 'paused' ELSE 'enabled' END AS state,
              CASE WHEN enabled = 1 AND paused = 0
                    AND (last_evaluated_at IS NULL OR datetime(last_evaluated_at, '+' || interval_seconds || ' seconds') <= datetime(?) )
                   THEN 'due' ELSE 'not due' END AS due,
              last_evaluated_at, last_due_at
       FROM factory_schedule ORDER BY id`,
      [at],
    );
    return {
      denominator: `${rows.length} persisted schedule${rows.length === 1 ? "" : "s"}; due is evaluated at ${at}`,
      columns,
      rows: toRows(rows, columns),
      note:
        rows.length === 0
          ? "no schedules are recorded"
          : "Due selection reads schedule state only; it does not claim queue work or create a factory order.",
    };
  },
};

export const scheduleHistory: Query = {
  name: "schedule-history",
  summary: "show every persisted schedule evaluation and dispatch outcome",
  usage: "dim q schedule-history [schedule-id]",
  spansHistory: true,
  window: "evaluated_at",
  run: (db, ctx) => {
    const filter = ctx.arg ? " WHERE schedule_id = ?" : "";
    const params = ctx.arg ? [ctx.arg] : [];
    const columns = [
      "schedule_id",
      "evaluated_at",
      "due",
      "dispatched",
      "selected_order_ids",
      "worker",
      "session_id",
      "harness",
      "model",
      "tier",
      "outcome",
      "reason",
    ];
    const rows = table(
      db,
      `SELECT schedule_id, evaluated_at,
              CASE WHEN due = 1 THEN 'due' ELSE 'not due' END AS due,
              CASE WHEN dispatched = 1 THEN 'dispatched' ELSE 'not dispatched' END AS dispatched,
              selected_order_ids, worker, session_id, harness, model, tier, outcome, reason
       FROM factory_schedule_invocation${filter}
       ORDER BY evaluated_at, id`,
      params,
    );
    return {
      denominator: `${rows.length} schedule invocation${rows.length === 1 ? "" : "s"} read from factory_schedule_invocation`,
      columns,
      rows: toRows(rows, columns),
      note: rows.length === 0 ? "no schedule invocations are recorded" : undefined,
    };
  },
};

export const factoryAnalytics: Query = {
  name: "factory-analytics",
  summary: "derive factory lifecycle metrics from first-party domain records",
  usage: "dim q factory-analytics [order-id]",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    const orderFilter = arg ? " WHERE order_id LIKE ? || '%'" : "";
    const params = arg ? [arg] : [];
    const orderEvents = (kind?: string): string => {
      const clauses = kind ? ["kind = ?"] : [];
      if (arg) clauses.push("order_id LIKE ? || '%'");
      return clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    };
    const orderEventParams = (kind?: string): string[] => (kind ? [kind, ...(arg ? [arg] : [])] : params);
    const scheduleScope = arg
      ? " WHERE EXISTS (SELECT 1 FROM json_each(factory_schedule_invocation.selected_order_ids) selected WHERE selected.value LIKE ? || '%')"
      : "";
    const scheduleWhere = (predicate: string): string =>
      `${scheduleScope ? `${scheduleScope} AND ` : " WHERE "}${predicate}`;
    const metric = (name: string, value: number): Record<string, unknown> => ({ metric: name, value });
    const rows: Record<string, unknown>[] = [];
    const attempts = scalar(
      db,
      `SELECT count(*) AS n FROM factory_order_attempt${orderFilter ? " WHERE kind = 'started' AND order_id LIKE ? || '%'" : " WHERE kind = 'started'"}`,
      ...params,
    );
    const ordersWithAttempts = scalar(
      db,
      `SELECT count(DISTINCT order_id) AS n FROM factory_order_attempt${orderFilter}`,
      ...params,
    );
    rows.push(metric("attempts", attempts), metric("retries", Math.max(0, attempts - ordersWithAttempts)));
    for (const row of table(
      db,
      `SELECT outcome, count(*) AS n FROM factory_order_attempt
       WHERE kind = 'finished'${arg ? " AND order_id LIKE ? || '%'" : ""}
       GROUP BY outcome ORDER BY outcome`,
      params,
    )) {
      rows.push(metric(`attempt_outcome:${row.outcome}`, Number(row.n)));
    }
    const holdSeconds = scalar(
      db,
      `WITH holds AS (
         SELECT order_id, ts, kind,
                lead(ts) OVER (PARTITION BY order_id ORDER BY ts, id) AS next_ts,
                lead(kind) OVER (PARTITION BY order_id ORDER BY ts, id) AS next_kind
         FROM factory_order_event
         WHERE kind IN ('hold_set', 'hold_released')${arg ? " AND order_id LIKE ? || '%'" : ""}
       )
       SELECT coalesce(round(sum((julianday(next_ts) - julianday(ts)) * 86400)), 0) AS n
       FROM holds WHERE kind = 'hold_set' AND next_kind = 'hold_released'`,
      params,
    );
    rows.push(metric("hold_seconds", holdSeconds));
    rows.push(
      metric(
        "provenance_events",
        scalar(
          db,
          `SELECT count(*) AS n FROM factory_order_event${orderEvents("queued")} AND EXISTS (SELECT 1 FROM json_each(factory_order_event.evidence))`,
          ...orderEventParams("queued"),
        ),
      ),
    );
    for (const row of table(
      db,
      `SELECT kind, count(*) AS n FROM factory_order_event
       WHERE kind IN ('completed', 'dropped', 'failed', 'moved')${arg ? " AND order_id LIKE ? || '%'" : ""}
       GROUP BY kind ORDER BY kind`,
      params,
    )) {
      rows.push(metric(`order_event:${row.kind}`, Number(row.n)));
    }
    for (const row of table(
      db,
      `SELECT kind, outcome, count(*) AS n FROM factory_order_delivery${orderFilter}
       GROUP BY kind, outcome ORDER BY kind, outcome`,
      params,
    )) {
      rows.push(metric(`${row.kind}:${row.outcome}`, Number(row.n)));
    }
    for (const row of table(
      db,
      `SELECT CASE kind WHEN 'artifact_approved' THEN 'approved'
                        WHEN 'artifact_returned' THEN 'returned' ELSE 'dropped' END AS decision,
              count(*) AS n
       FROM factory_order_event
       WHERE kind IN ('artifact_approved', 'artifact_returned', 'dropped')${arg ? " AND order_id LIKE ? || '%'" : ""}
       GROUP BY decision ORDER BY decision`,
      params,
    )) {
      rows.push(metric(`verdict:${row.decision}`, Number(row.n)));
    }
    for (const row of table(
      db,
      `SELECT coalesce(harness, '(unknown)') || '/' || coalesce(model, '(unknown)') || '/' || coalesce(tier, '(unknown)') AS attribution,
              count(*) AS n
       FROM factory_order_attempt
       WHERE kind = 'finished'${arg ? " AND order_id LIKE ? || '%'" : ""}
       GROUP BY attribution ORDER BY attribution`,
      params,
    )) {
      rows.push(metric(`worker_execution:${row.attribution}`, Number(row.n)));
    }
    rows.push(
      metric(
        "schedule_evaluations",
        scalar(db, `SELECT count(*) AS n FROM factory_schedule_invocation${scheduleScope}`, ...params),
      ),
      metric(
        "schedule_due",
        scalar(
          db,
          `SELECT count(*) AS n FROM factory_schedule_invocation${scheduleWhere("due = 1")}`,
          ...params,
        ),
      ),
      metric(
        "schedule_dispatched",
        scalar(
          db,
          `SELECT count(*) AS n FROM factory_schedule_invocation${scheduleWhere("dispatched = 1")}`,
          ...params,
        ),
      ),
      metric(
        "schedule_dispatch_failures",
        scalar(
          db,
          `SELECT count(*) AS n FROM factory_schedule_invocation${scheduleWhere("outcome = 'failed'")}`,
          ...params,
        ),
      ),
    );
    return {
      denominator:
        `${ordersWithAttempts} order${ordersWithAttempts === 1 ? "" : "s"} with attempt history` +
        (arg ? ` matching ${arg}` : "") +
        "; metrics are derived from factory_order_event, factory_order_attempt, factory_order_delivery, and factory_schedule_invocation",
      columns: ["metric", "value"],
      rows: toRows(rows, ["metric", "value"]),
      note: rows.length === 0 ? "no first-party domain records are available for these metrics" : undefined,
    };
  },
};

export const slices: Query = {
  name: "slices",
  summary: "commits that had no run of the repo's own check in front of them",
  usage: "dim q slices [id-prefix]",
  window: "c.ts_call",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["session", "at", "checked", "command"];
    const w = window("c.ts_call", ctx);
    const all = table(
      db,
      `WITH calls AS (
         SELECT c.id, c.session_id, c.ts_call AS ts, c.command, c.is_error AS failed,
                s.project AS repo, rc.command AS declared_check,
                max(CASE WHEN g.subcommand = 'commit' THEN 1 ELSE 0 END) AS is_commit
         FROM tool_call c
         JOIN session s ON s.id = c.session_id
         LEFT JOIN repo_check rc ON rc.repo = s.project
         LEFT JOIN git_command g ON g.tool_call_id = c.id
         WHERE c.tool_name IN ('Bash', 'CommandExecution') AND c.ts_call IS NOT NULL
           AND c.command IS NOT NULL
           ${arg ? "AND c.session_id LIKE ? || '%'" : ""}${w.sql}
         GROUP BY c.id
       ),
       m AS (SELECT *, CASE WHEN declared_check IS NOT NULL AND command = declared_check THEN 1 ELSE 0 END AS is_check FROM calls),
       commits AS (
         -- A commit the subject gate refused is not a boundary: nothing changed
         -- between it and the retry but the message, so the check in front of it
         -- still stands for the commit that landed.
         SELECT m.*, (SELECT max(p.ts) FROM m p
                      WHERE p.session_id = m.session_id AND p.is_commit = 1
                        AND coalesce(p.failed, 0) = 0 AND p.ts < m.ts) AS prev
         FROM m WHERE m.is_commit = 1
       )
       SELECT substr(session_id, 1, 8) AS session,
              substr(ts, 1, 16) AS at,
              -- The check and the commit are often one shell call, which is the
              -- order the station asks for, so that call checks itself.
              CASE WHEN commits.declared_check IS NULL THEN 'undeclared'
              WHEN commits.is_check = 1 OR EXISTS (
                SELECT 1 FROM m t WHERE t.session_id = commits.session_id AND t.is_check = 1
                  AND t.ts < commits.ts AND (commits.prev IS NULL OR t.ts > commits.prev)
              ) THEN 'yes' ELSE 'no' END AS checked,
              replace(substr(command, 1, 60), char(10), ' ') AS command,
              (SELECT s.project FROM session s WHERE s.id = commits.session_id) AS project
       FROM commits ORDER BY ts DESC`,
      [...(arg ? [arg] : []), ...w.params],
    );
    const records = all.filter((r) => !(r.project && isScratchRepo(String(r.project))));
    const unchecked = records.filter((r) => r.checked === "no").length;
    return {
      denominator:
        `${records.length} commits, ${unchecked} with no check in front of them (${windowLine(ctx)})` +
        (all.length > records.length ? `, ${all.length - records.length} in scratch trees not counted` : ""),
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "no commit was made through a shell call in this window"
          : "A check is the exact command the repository declares; a repository that declares none " +
            "reads as undeclared. `checked` means a check ran in the same session since the " +
            "previous commit, never that it passed — a failing run and a passing one look alike here. " +
            "This observes; `dim install-commit-gate` is what enforces.",
    };
  },
};

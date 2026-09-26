import type { Database } from "bun:sqlite";
import {
  CLAUDE_EDITS,
  CLAUDE_STOPS,
  claudeOnly,
  homeOf,
  type Query,
  type QueryContext,
  scalar,
  stoppedByOwner,
  table,
  toRows,
  window,
  windowLine,
} from "./query";
import { repeats } from "./query-correction";
import { parsePassageRef } from "./search-passage-ref";

export const corpusLine = (db: Database, ctx: QueryContext): string => {
  const w = window("last_seen_at", ctx, "WHERE");
  const sessions = scalar(db, `SELECT count(*) AS n FROM session${w.sql}`, ...w.params);
  const m = window("ts", ctx, "WHERE");
  const messages = scalar(db, `SELECT count(*) AS n FROM message${m.sql}`, ...m.params);
  const responses = scalar(db, `SELECT count(*) AS n FROM usage${m.sql}`, ...m.params);
  return `${sessions} sessions, ${messages} messages, ${responses} API responses (${windowLine(ctx)})`;
};

export const sessions: Query = {
  name: "sessions",
  summary: "most recently active sessions, newest first",
  window: "s.last_seen_at",
  run: (db, ctx) => {
    const columns = ["id", "tool", "project", "started", "turns", "responses", "output", "ended"];
    const records = table(
      db,
      `SELECT substr(s.id, 1, 8) AS id, s.tool,
              replace(coalesce(s.project, ''), ? || '/', '') AS project,
              substr(s.started_at, 1, 16) AS started,
              (SELECT count(*) FROM turn t WHERE t.session_id = s.id) AS turns,
              (SELECT count(*) FROM usage u WHERE u.session_id = s.id) AS responses,
              (SELECT sum(u.output_tokens) FROM usage u WHERE u.session_id = s.id) AS output,
              coalesce(s.end_reason, '') AS ended
       FROM session s WHERE s.parent_id IS NULL${window("s.last_seen_at", ctx).sql}
       ORDER BY s.last_seen_at DESC LIMIT 40`,
      [homeOf(ctx), ...window("s.last_seen_at", ctx).params],
    );
    const w = window("last_seen_at", ctx);
    const ended = scalar(
      db,
      `SELECT count(*) AS n FROM session WHERE end_reason IS NOT NULL${w.sql}`,
      ...w.params,
    );
    return {
      denominator: `${corpusLine(db, ctx)}; ${ended} sessions have an end reason from the hook spool`,
      columns,
      rows: toRows(records, columns),
      note:
        ended === 0
          ? "No session has an end reason: the hooks are not installed, so abandoned and open look alike. `dim install-hooks`."
          : undefined,
    };
  },
};

export const session: Query = {
  name: "session",
  summary: "one session in full",
  usage: "dim q session <id-prefix>",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q session <id-prefix>"]] };
    }
    const found = table(
      db,
      `SELECT id, tool, project, git_branch, cli_version, entrypoint, started_at, last_seen_at,
              end_reason, first_model, last_model, title
       FROM session WHERE id LIKE ? || '%' LIMIT 2`,
      [arg],
    );
    if (found.length === 0) {
      return { denominator: "", columns: ["id"], rows: [], note: `no session starts with ${arg}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["id"], rows: [], note: `${arg} matches more than one session` };
    }
    const s = (found[0] ?? {}) as Record<string, string | null | undefined>;
    const id = s.id as string;
    const text = (v: string | null | undefined): string | null => v ?? null;
    const facts: [string, string | number | null][] = [
      ["tool", text(s.tool)],
      ["project", text(s.project)],
      ["branch", text(s.git_branch)],
      ["cli", text(s.cli_version)],
      ["entrypoint", text(s.entrypoint)],
      ["title", text(s.title)],
      ["started", text(s.started_at)],
      ["last seen", text(s.last_seen_at)],
      ["end reason", s.end_reason ?? "not recorded (no hook)"],
      ["models", [s.first_model, s.last_model].filter(Boolean).join(" → ") || null],
      ["messages", scalar(db, "SELECT count(*) AS n FROM message WHERE session_id = ?", id)],
      [
        "user prompts",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND role = 'user' AND prompt_source IN ('typed','queued')",
          id,
        ),
      ],
      ["responses", scalar(db, "SELECT count(*) AS n FROM usage WHERE session_id = ?", id)],
      [
        "output tokens",
        scalar(db, "SELECT coalesce(sum(output_tokens),0) AS n FROM usage WHERE session_id = ?", id),
      ],
      [
        "cache read",
        scalar(db, "SELECT coalesce(sum(cache_read_tokens),0) AS n FROM usage WHERE session_id = ?", id),
      ],
      ["turns", scalar(db, "SELECT count(*) AS n FROM turn WHERE session_id = ?", id)],
      [
        "interrupted turns",
        scalar(db, "SELECT count(*) AS n FROM turn WHERE session_id = ? AND status = 'interrupted'", id),
      ],
      [
        "user interruptions",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND interrupted_message_id IS NOT NULL",
          id,
        ),
      ],
      [
        "tool calls you rejected",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND denial_kind = 'user-rejected'",
          id,
        ),
      ],
      [
        "tool calls auto mode blocked",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND denial_kind IS NOT NULL AND denial_kind <> 'user-rejected'",
          id,
        ),
      ],
      ["subagents", scalar(db, "SELECT count(*) AS n FROM session WHERE parent_id = ?", id)],
    ];
    return {
      denominator: `session ${id}`,
      columns: ["fact", "value"],
      rows: facts.map(([k, v]) => [k, v]),
    };
  },
};

export const thread: Query = {
  name: "thread",
  summary: "read one session's exchange, or the messages around a timestamp",
  usage: "dim q thread <id-prefix>[@<ts>]",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q thread <id-prefix>[@<ts>]"]] };
    }
    const { id: prefix, at } = parsePassageRef(arg);
    const found = table(db, "SELECT id FROM session WHERE id LIKE ? || '%' LIMIT 2", [prefix]);
    if (found.length === 0) {
      return { denominator: "", columns: ["id"], rows: [], note: `no session starts with ${prefix}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["id"], rows: [], note: `${prefix} matches more than one session` };
    }
    const id = found[0]?.id as string;
    const columns = ["when", "role", "skill", "text"];
    const said = `FROM message WHERE session_id = ? AND text IS NOT NULL
                  AND is_skill_body = 0 AND is_meta = 0`;
    const select = `SELECT substr(ts, 1, 16) AS "when", role,
                           coalesce(attribution_skill, '') AS skill,
                           replace(substr(text, 1, 240), char(10), ' ') AS text, ts`;
    const records = at
      ? table(
          db,
          `SELECT * FROM (
             SELECT * FROM (${select} ${said} AND ts <= ? ORDER BY ts DESC LIMIT 12)
             UNION
             SELECT * FROM (${select} ${said} AND ts > ? ORDER BY ts ASC LIMIT 12)
           ) ORDER BY ts`,
          [id, at, id, at],
        )
      : table(db, `${select} ${said} ORDER BY ts LIMIT 40`, [id]);
    const all = scalar(db, `SELECT count(*) AS n ${said}`, id);
    return {
      denominator: `session ${id}: ${all} messages anyone said${at ? `, centered on ${at}` : ""}`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "nothing was said in this session outside tool calls and injected text"
          : "Text is cut at 240 characters. Tool calls, their results, skill bodies and injected meta are not here.",
    };
  },
};

export const resume: Query = {
  name: "resume",
  summary: "the factual half of a handoff: branch, files in play, last pushback, last exchange",
  usage: "dim q resume <id-prefix>",
  spansHistory: true,
  window: null,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q resume <id-prefix>"]] };
    }
    const found = table(
      db,
      "SELECT id, project, git_branch, last_seen_at FROM session WHERE id LIKE ? || '%' LIMIT 2",
      [arg],
    );
    if (found.length === 0) {
      return { denominator: "", columns: ["what"], rows: [], note: `no session starts with ${arg}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["what"], rows: [], note: `${arg} matches more than one session` };
    }
    const s = found[0] as Record<string, string | null>;
    const id = s.id as string;
    const rows: (string | number | null)[][] = [
      ["branch", s.git_branch ?? "(none recorded)"],
      ["project", s.project ?? "(none recorded)"],
      ["last active", s.last_seen_at ?? null],
    ];

    const handoff = table(
      db,
      `SELECT next FROM factory_handoff
       WHERE session_id = ? AND role = 'assistant'
       ORDER BY ts DESC LIMIT 1`,
      [id],
    )[0];
    if (handoff) rows.push(["next", handoff.next as string]);

    for (const f of table(
      db,
      `SELECT file_path, count(*) AS edits, max(ts_call) AS last_edit
       FROM tool_call
       WHERE session_id = ? AND tool_name IN ('Edit','Write') AND file_path IS NOT NULL
       GROUP BY file_path ORDER BY last_edit DESC LIMIT 8`,
      [id],
    )) {
      rows.push(["edited", `${f.file_path} (${f.edits})`]);
    }

    for (const f of table(
      db,
      `SELECT tool_name, count(*) AS failures FROM tool_call
       WHERE session_id = ? AND is_error = 1 GROUP BY tool_name ORDER BY failures DESC LIMIT 3`,
      [id],
    )) {
      rows.push(["failed", `${f.tool_name} × ${f.failures}`]);
    }

    for (const p of table(
      db,
      `SELECT substr(ts, 1, 16) AS ts, replace(substr(coalesce(user_feedback, text, ''), 1, 160), char(10), ' ') AS said
       FROM message
       WHERE session_id = ? AND role = 'user' AND ${stoppedByOwner("")}
       ORDER BY ts DESC LIMIT 3`,
      [id],
    )) {
      rows.push(["stopped", `${p.ts} ${p.said}`]);
    }

    for (const m of table(
      db,
      `SELECT * FROM (
         SELECT substr(ts, 1, 16) AS ts, role,
                replace(substr(text, 1, 200), char(10), ' ') AS said
         FROM message
         WHERE session_id = ? AND text IS NOT NULL AND is_skill_body = 0 AND is_meta = 0
         ORDER BY ts DESC LIMIT 6
       ) ORDER BY ts`,
      [id],
    )) {
      rows.push(["said", `${m.ts} ${m.role}: ${m.said}`]);
    }

    return {
      denominator: `session ${id}`,
      columns: ["what", "detail"],
      rows,
      note:
        "Facts only. The next move is the handoff text written in that session; no move is inferred here. " +
        "Run `dim sync` first if the session is still open, since only written bytes are read. " +
        claudeOnly(CLAUDE_EDITS, CLAUDE_STOPS),
    };
  },
};

export const delegation: Query = {
  name: "delegation",
  summary: "work handed to a subagent or a peer, by the skill that handed it over",
  window: "t.ts_call",
  run: (db, ctx) => {
    const columns = ["skill", "handoffs", "subagents", "subagent_output", "failed", "sessions"];
    const w = window("t.ts_call", ctx, "WHERE");
    const records = table(
      db,
      `WITH handoff AS (
         SELECT t.session_id, coalesce(t.attribution_skill, '(no skill)') AS skill,
                t.tool_name, t.is_error
         FROM tool_call t
         WHERE t.tool_name IN ('Agent', 'SendMessage')${window("t.ts_call", ctx).sql}
       ),
       parents AS (SELECT DISTINCT session_id, skill FROM handoff WHERE tool_name = 'Agent'),
       kids AS (
         SELECT p.skill, count(DISTINCT c.id) AS subagents,
                coalesce(sum(u.output_tokens), 0) AS subagent_output
         FROM parents p
         JOIN session c ON c.parent_id = p.session_id
         LEFT JOIN usage u ON u.session_id = c.id
         GROUP BY p.skill
       )
       SELECT h.skill, count(*) AS handoffs,
              coalesce(k.subagents, 0) AS subagents,
              coalesce(k.subagent_output, 0) AS subagent_output,
              sum(coalesce(h.is_error, 0)) AS failed,
              count(DISTINCT h.session_id) AS sessions
       FROM handoff h LEFT JOIN kids k ON k.skill = h.skill
       GROUP BY h.skill ORDER BY handoffs DESC`,
      w.params,
    );
    const spawned = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call t WHERE t.tool_name = 'Agent'${window("t.ts_call", ctx).sql}`,
      ...w.params,
    );
    const messaged = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call t WHERE t.tool_name = 'SendMessage'${window("t.ts_call", ctx).sql}`,
      ...w.params,
    );
    const children = scalar(db, "SELECT count(*) AS n FROM session WHERE parent_id IS NOT NULL");
    return {
      denominator:
        `${spawned} agents spawned and ${messaged} messages sent to a peer in this window ` +
        `(${windowLine(ctx)}); ${children} subagent sessions recorded in the corpus`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "nothing was handed to a subagent or a peer in this window"
          : "`subagents` and `subagent_output` count every child of a session that skill ever delegated " +
            "in, not only the children of these calls, so they are the scale of the delegation a skill " +
            "sits alongside rather than a per-call figure. A peer's own session is not a child and its " +
            "output is not counted here.",
    };
  },
};

export const running: Query = {
  name: "running",
  summary: "sessions and subagents active in the last few minutes, and what each is doing",
  usage: "dim q running [minutes]",
  spansHistory: true,
  window: "s.last_seen_at",
  run: (db, ctx) => {
    const { arg } = ctx;
    const minutes = arg && /^\d+$/.test(arg) ? Number(arg) : 30;
    const columns = ["id", "kind", "project", "last_seen", "doing"];
    const records = table(
      db,
      `SELECT substr(s.id, 1, 8) AS id,
              CASE WHEN s.parent_id IS NULL THEN s.tool
                   ELSE 'sub:' || coalesce(s.agent_type, '?') END AS kind,
              replace(coalesce(s.project, ''), ? || '/', '') AS project,
              substr(s.last_seen_at, 12, 5) AS last_seen,
              coalesce(
                (SELECT replace(substr(m.text, 1, 140), char(10), ' ') FROM message m
                 WHERE m.session_id = s.id AND m.text IS NOT NULL
                   AND m.is_skill_body = 0 AND m.is_meta = 0
                 ORDER BY m.ts DESC LIMIT 1),
                (SELECT t.tool_name || ' ' || coalesce(t.file_path, '') FROM tool_call t
                 WHERE t.session_id = s.id ORDER BY t.ts_call DESC LIMIT 1),
                '(nothing recorded)') AS doing
       FROM session s
       -- Timestamps are stored ISO with a T; datetime() renders a space, which
       -- sorts below it and would put every row inside the window.
       WHERE s.last_seen_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
       ORDER BY s.last_seen_at DESC LIMIT 40`,
      [homeOf(ctx), `-${minutes} minutes`],
    );
    const synced = scalar(db, "SELECT count(*) AS n FROM source_file");
    return {
      denominator: `sessions active in the last ${minutes} minutes, of ${synced} source files read`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? `nothing active in the last ${minutes} minutes — run \`dim sync\` first, since only bytes already read are here`
          : "A subagent's rows are its own transcript, not its report to the parent. This is as fresh as the " +
            "last `dim sync`: nothing here watches a file.",
    };
  },
};

export const digest: Query = {
  name: "digest",
  summary: "the whole week in one call: friction, where work happened, what you repeated",
  window: ["last_seen_at", "ts_call", "m.ts", "ts", "first_seen"],
  run: (db, ctx) => {
    const w = (col: string) => window(col, ctx);
    const rows: (string | number | null)[][] = [];
    const add = (measure: string, value: string | number | null) => rows.push([measure, value]);

    const sessions = scalar(
      db,
      `SELECT count(*) AS n FROM session WHERE parent_id IS NULL${window("last_seen_at", ctx).sql}`,
      ...w("last_seen_at").params,
    );
    add("sessions", sessions);

    const edited = scalar(
      db,
      `SELECT count(*) AS n FROM (SELECT DISTINCT session_id, file_path FROM tool_call
        WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL${w("ts_call").sql})`,
      ...w("ts_call").params,
    );
    const unskilled = scalar(
      db,
      `SELECT count(*) AS n FROM (SELECT DISTINCT session_id, file_path FROM tool_call
        WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL
          AND attribution_skill IS NULL${w("ts_call").sql})`,
      ...w("ts_call").params,
    );
    add("files edited", edited);
    add(
      "edited under no skill",
      edited === 0 ? "—" : `${unskilled} (${Math.round((100 * unskilled) / edited)}%)`,
    );

    const stops = scalar(
      db,
      `SELECT count(*) AS n FROM message m
       WHERE m.role = 'user' AND ${stoppedByOwner()}${w("m.ts").sql}`,
      ...w("m.ts").params,
    );
    add("times you stopped the agent", stops);
    add("stops per file edited", edited === 0 ? "—" : (stops / edited).toFixed(2));

    const handoffs = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call
       WHERE tool_name IN ('Agent','SendMessage')${w("ts_call").sql}`,
      ...w("ts_call").params,
    );
    add("work handed to a subagent or peer", handoffs);

    const skillVersions = scalar(
      db,
      `SELECT count(DISTINCT body_sha256) AS n FROM skill_load
       WHERE body_sha256 IS NOT NULL${w("ts").sql}`,
      ...w("ts").params,
    );
    const ruleVersions = scalar(
      db,
      `SELECT count(*) AS n FROM guidance_version${window("first_seen", ctx, "WHERE").sql}`,
      ...w("first_seen").params,
    );
    add("skill versions loaded", skillVersions);
    add("rules file versions written", ruleVersions);

    for (const r of repeats.run(db, ctx).rows.slice(0, 5)) {
      add("repeated", `"${r[0]}" — ${r[1]} sessions`);
    }

    return {
      denominator: `${windowLine(ctx)}`,
      columns: ["measure", "value"],
      rows,
      note:
        (sessions === 0
          ? "no session in this window. "
          : "A repeated phrase is a candidate rule or a rule that is not reaching the tool that needs it. " +
            "Nothing here is an effect of anything else here: read a change as where to look. ") +
        claudeOnly(CLAUDE_EDITS, CLAUDE_STOPS),
    };
  },
};

export const chain: Query = {
  name: "chain",
  summary: "sessions that continued one another through a handoff, longest chain first",
  usage: "dim q chain [id-prefix]",
  spansHistory: true,
  window: "to_ts",
  run: (db, ctx) => {
    const { arg } = ctx;
    if (arg) {
      const columns = ["step", "session", "ran", "gap_min", "title"];
      const records = table(
        db,
        `WITH RECURSIVE back(from_session, to_session, to_ts, from_ts, title) AS (
           SELECT from_session, to_session, to_ts, from_ts, title FROM handoff_link
           WHERE to_session LIKE ? || '%'
           UNION
           SELECT l.from_session, l.to_session, l.to_ts, l.from_ts, l.title
           FROM handoff_link l JOIN back b ON l.to_session = b.from_session
         ),
         forward(from_session, to_session, to_ts, from_ts, title) AS (
           SELECT from_session, to_session, to_ts, from_ts, title FROM handoff_link
           WHERE from_session LIKE ? || '%'
           UNION
           SELECT l.from_session, l.to_session, l.to_ts, l.from_ts, l.title
           FROM handoff_link l JOIN forward f ON l.from_session = f.to_session
         ),
         edge AS (SELECT * FROM back UNION SELECT * FROM forward)
         SELECT row_number() OVER (ORDER BY to_ts) AS step,
                substr(from_session, 1, 8) || ' → ' || substr(to_session, 1, 8) AS session,
                substr(to_ts, 1, 16) AS ran,
                cast((julianday(to_ts) - julianday(from_ts)) * 1440 AS INTEGER) AS gap_min,
                ltrim(replace(title, '# Handoff', ''), ' —') AS title
         FROM edge ORDER BY to_ts`,
        [arg, arg],
      );
      return {
        denominator: `the chain ${arg} sits in: ${records.length} links`,
        columns,
        rows: toRows(records, columns),
        note:
          records.length === 0
            ? `no handoff joins ${arg} to another session; \`dim q resume ${arg}\` has what it left`
            : "`gap_min` is the wait between a handoff being printed and pasted, not work. The walk " +
              "follows the edge, not the title, so it crosses a task that was renamed midway, and it " +
              "branches where one handoff was pasted into two sessions. A chain breaks where the " +
              "writing session's transcript was pruned before it was read.",
      };
    }

    const columns = ["links", "first", "last", "title"];
    const w = window("to_ts", ctx, "WHERE");
    const records = table(
      db,
      `SELECT count(*) AS links,
              substr(min(from_ts), 1, 10) AS first,
              substr(max(to_ts), 1, 10) AS last,
              ltrim(replace(title, '# Handoff', ''), ' —') AS title
       FROM handoff_link${w.sql}
       GROUP BY title ORDER BY links DESC, last DESC LIMIT 30`,
      w.params,
    );
    const links = scalar(db, "SELECT count(*) AS n FROM handoff_link");
    const pasted = scalar(
      db,
      `SELECT count(*) AS n FROM message WHERE role = 'user' AND text LIKE '%# Handoff%' AND text LIKE '%## Next%'`,
    );
    return {
      denominator: `${links} links joined, of ${pasted} handoffs pasted into a session (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        links === 0
          ? "nothing is joined; `dim sync` builds this table from the transcripts it has read"
          : "Grouped by the handoff title, which is what the two sides share, so a task renamed midway " +
            "reads as two chains. A paste with no link means the session that printed it was pruned " +
            "before its transcript was read.",
    };
  },
};

import type { Database } from "bun:sqlite";
import { type Query, type QueryContext, scalar, table, toRows, window, windowLine } from "./query";
import { SAID } from "./query-search";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

const TRANSCRIPT_READING_CHARS = 240;
const RUNNING_GLANCE_CHARS = 140;

function passageTime(ref: string): string | undefined {
  const cut = ref.lastIndexOf("@");
  if (cut === -1) return undefined;
  const tail = ref.slice(cut + 1);
  return ISO_TIMESTAMP.test(tail) ? tail : undefined;
}

function parsePassageRef(ref: string): { id: string; at?: string } {
  const at = passageTime(ref);
  return at === undefined ? { id: ref } : { id: ref.slice(0, ref.length - at.length - 1), at };
}

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
  window: "recent",
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
      [ctx.home, ...window("s.last_seen_at", ctx).params],
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
  window: "none",
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
  window: "none",
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
    const said = `FROM message m WHERE m.session_id = ? AND m.text IS NOT NULL AND ${SAID}`;
    const select = `SELECT substr(ts, 1, 16) AS "when", role,
                           coalesce(attribution_skill, '') AS skill,
                           replace(substr(text, 1, ${TRANSCRIPT_READING_CHARS}), char(10), ' ') AS text, ts`;
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
          : `Text is cut at ${TRANSCRIPT_READING_CHARS} characters. Tool calls, their results, skill bodies and injected reminders are not here.`,
    };
  },
};

export const running: Query = {
  name: "running",
  summary: "sessions and subagents active in the last few minutes, and what each is doing",
  usage: "dim q running [minutes]",
  window: "none",
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
                (SELECT replace(substr(m.text, 1, ${RUNNING_GLANCE_CHARS}), char(10), ' ') FROM message m
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
      [ctx.home, `-${minutes} minutes`],
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

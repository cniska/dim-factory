import { UsageError } from "./cli-contract";
import { type Query, requiredArg, scalar, table, toRows } from "./query";
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

function minutesIn(arg: string): number {
  if (!/^\d+$/.test(arg)) throw new UsageError(`${arg} is not a count; usage: ${running.usage}`);
  return Number(arg);
}

export const thread: Query = {
  name: "thread",
  summary: "read one session's exchange, or the messages around a timestamp",
  usage: "dim q thread <id-prefix>[@<ts>]",
  window: "none",
  run: (db, ctx) => {
    const { id: prefix, at } = parsePassageRef(requiredArg(ctx, thread.usage));
    const found = table(db, "SELECT id FROM session WHERE id LIKE ? || '%' LIMIT 2", [prefix]);
    if (found.length > 1) throw new UsageError(`${prefix} matches more than one session`);
    const [match] = found;
    if (!match) {
      return { denominator: "", columns: ["id"], rows: [], note: `no session starts with ${prefix}` };
    }
    const id = match.id as string;
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
    const minutes = ctx.arg === undefined ? 30 : minutesIn(ctx.arg);
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

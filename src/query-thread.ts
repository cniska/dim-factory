import { UsageError } from "./cli-contract";
import { type Query, requiredArg, scalar, table, toRows } from "./query";
import { SAID } from "./query-search";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

const TRANSCRIPT_READING_CHARS = 240;

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

export const thread: Query = {
  name: "thread",
  summary: "read one session's exchange, or the messages around a timestamp",
  usage: "dim q thread <id-prefix>[@<ts>]",
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
      : table(db, `${select} ${said} ORDER BY ts`, [id]);
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

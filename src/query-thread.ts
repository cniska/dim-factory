import { UsageError } from "./cli-contract";
import { type Query, requiredArg, SAID, scalar, select } from "./query";

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
  usage: "dim query thread <id-prefix>[@<ts>]",
  run: (db, ctx) => {
    const { id: prefix, at } = parsePassageRef(requiredArg(ctx, thread.usage));
    const found = db
      .query<{ id: string }, [string]>("SELECT id FROM session WHERE instr(lower(id), lower(?)) = 1 LIMIT 2")
      .all(prefix);
    if (found.length > 1) throw new UsageError(`${prefix} matches more than one session`);
    const said = `FROM message m WHERE m.session_id = ? AND m.text IS NOT NULL AND ${SAID}`;
    const passage = `SELECT substr(ts, 1, 16) AS "when", role,
                            coalesce(attribution_skill, '') AS skill,
                            replace(substr(text, 1, ${TRANSCRIPT_READING_CHARS}), char(10), ' ') AS text, ts`;
    const shown = (inner: string, params: string[]) =>
      select(db, `SELECT "when", role, skill, text FROM (${inner}) ORDER BY ts`, params);
    const [match] = found;
    if (!match) {
      return {
        denominator: "0 sessions",
        ...shown(`${passage} ${said}`, [""]),
        note: `no session starts with ${prefix}`,
      };
    }
    const { id } = match;
    const result = at
      ? shown(
          `SELECT * FROM (${passage} ${said} AND ts <= ? ORDER BY ts DESC LIMIT 12)
           UNION ALL
           SELECT * FROM (${passage} ${said} AND ts > ? ORDER BY ts ASC LIMIT 12)`,
          [id, at, id, at],
        )
      : shown(`${passage} ${said}`, [id]);
    const all = scalar(db, `SELECT count(*) AS n ${said}`, [id]);
    return {
      denominator: `session ${id}: ${all} messages anyone said${at ? `, centered on ${at}` : ""}`,
      ...result,
      note:
        result.rows.length === 0
          ? "nothing was said in this session outside tool calls and injected text"
          : `Text is cut at ${TRANSCRIPT_READING_CHARS} characters. Tool calls, their results, skill bodies and injected reminders are not here.`,
    };
  },
};

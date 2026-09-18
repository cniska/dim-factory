/**
 * How one distilled passage is addressed: `<session>@<timestamp>`, which `search`
 * prints, `thread` reads and `bench` grades, so the string a reader follows to an
 * exchange is the string a corpus scores.
 *
 * A session id may itself contain `@` — a subagent's is `<agent>@<parent>` — so
 * the delimiter cannot be found by splitting. The timestamp is recognized by its
 * shape instead, and everything before it is the id whatever it holds.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

export type PassageRef = { id: string; at?: string };

/** The timestamp a ref ends in, or undefined where it names no passage. */
function passageTime(ref: string): string | undefined {
  const cut = ref.lastIndexOf("@");
  if (cut === -1) return undefined;
  const tail = ref.slice(cut + 1);
  return ISO_TIMESTAMP.test(tail) ? tail : undefined;
}

export function parsePassageRef(ref: string): PassageRef {
  const at = passageTime(ref);
  return at === undefined ? { id: ref } : { id: ref.slice(0, ref.length - at.length - 1), at };
}

import { type Command, UsageError } from "./command";
import { embedQuestion } from "./embed";
import { dbPath, resolveHomeDir } from "./paths";
import { findQuery, QUERIES } from "./queries";
import type { QueryResult } from "./query";
import { openReadOnly } from "./read-db";
import { capRows, DEFAULT_MAX_ROWS, rowsFromArgs } from "./row-cap";
import { DEFAULT_WINDOW, windowFromArgs } from "./since";
import { trace } from "./trace";

export const qCommand: Command = {
  name: "q",
  usage: `usage: dim q <name> [arg] [--since <n>d|YYYY-MM-DD | --all] [--rows <n>]; dim q list names them; the window is the last ${DEFAULT_WINDOW} and ${DEFAULT_MAX_ROWS} rows print unless widened`,
  summary: "ask the database a named question",
  async run(args) {
    const name = args[0];
    if (!name || name === "list") {
      return {
        queries: QUERIES.map((q) => ({
          name: q.name,
          usage: q.usage ?? `dim q ${q.name}`,
          summary: q.summary,
        })),
      };
    }
    const query = findQuery(name);
    if (!query) throw new UsageError(`no query named ${name}; dim q list names them`);
    const flagValues = new Set<string>();
    for (const flag of ["--since", "--rows"]) {
      const at = args.indexOf(flag);
      if (at !== -1 && args[at + 1]) flagValues.add(args[at + 1] as string);
    }
    const arg = args.find((a) => !a.startsWith("--") && a !== name && !flagValues.has(a));
    const since = windowFromArgs(args, { spansHistory: query.spansHistory });
    const maxRows = rowsFromArgs(args);
    const question = query.embedsArg && arg ? await embedQuestion(arg) : undefined;
    const db = openReadOnly(dbPath());
    const started = Date.now();
    let result: QueryResult | undefined;
    try {
      result = query.run(db, { arg, since, home: resolveHomeDir(), question });
      return { ...result, ...capRows(result.rows, maxRows) };
    } finally {
      trace({
        event: "query.completed",
        command: "q",
        name: query.name,
        path: result?.path,
        rowCount: result?.rows.length,
        durationMs: Date.now() - started,
      });
      db.close();
    }
  },
};

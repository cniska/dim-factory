import type { Command } from "./cli-contract";
import { closeDb, openDb } from "./db";
import { dbPath } from "./paths";

export const statsCommand: Command = {
  name: "stats",
  usage: "usage: dim stats",
  summary: "row counts and token totals per tool and model",
  run() {
    const db = openDb(dbPath());
    try {
      const counts = db
        .prepare<{ files: number; sessions: number; messages: number; usage_rows: number }, []>(
          `SELECT (SELECT count(*) FROM source_file) AS files,
                  (SELECT count(*) FROM session) AS sessions,
                  (SELECT count(*) FROM message) AS messages,
                  (SELECT count(*) FROM usage) AS usage_rows`,
        )
        .get();
      const models = db
        .prepare<
          {
            tool: string;
            model: string | null;
            responses: number;
            input: number;
            cache_read: number;
            output: number;
          },
          []
        >(
          `SELECT s.tool, u.model, count(*) AS responses, sum(u.input_tokens) AS input,
                  sum(u.cache_read_tokens) AS cache_read, sum(u.output_tokens) AS output
           FROM usage u JOIN session s ON s.id = u.session_id
           GROUP BY s.tool, u.model ORDER BY responses DESC`,
        )
        .all();
      return { counts, models };
    } finally {
      closeDb(db);
    }
  },
};

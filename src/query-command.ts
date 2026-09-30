import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { listQueries, runQuery } from "./query-ops";
import { findQuery } from "./query-registry";
import { DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

export const queryCommand: Command = {
  name: "query",
  usage: "usage: dim query <name> [arg] [--rows <n>] | dim query list",
  summary: `ask the database a named question; ${DEFAULT_MAX_ROWS} rows print unless --rows widens them`,
  run(args) {
    const name = args[0];
    if (!name || name === "list") return listQueries();
    const query = findQuery(name);
    if (!query) throw new UsageError(`no query named ${name}; dim query list names them`);
    const { positionals, flags } = parseArgs(
      args.slice(1),
      { positionals: [0, 1], flags: ["rows"] },
      (message) => new UsageError(`dim query ${name} ${message}`),
    );
    return runQuery(query, positionals[0], rowsOf(flags.rows));
  },
};

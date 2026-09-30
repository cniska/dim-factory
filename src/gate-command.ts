import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { warn } from "./cli-warn";
import { judge } from "./gate";
import { GATE_HOOKS, REFUSED_EXIT } from "./gate-contract";

const USAGE = `usage: dim gate <installed hook: ${GATE_HOOKS.join(" | ")}> [<arguments git passes it>...]`;

export const gateCommand: Command = {
  name: "gate",
  usage: USAGE,
  summary: "judge a commit or push for the git hook the commit gate installed, which calls it",
  raw: () => true,
  run(args) {
    const [hook, ...rest] = args;
    if (hook === undefined) throw new UsageError(USAGE);
    const refusal = judge(hook, {
      args: rest,
      cwd: process.cwd(),
      env: process.env,
      stdin: () => readFileSync(0, "utf8"),
      say: warn,
    });
    if (refusal === null) throw new UsageError(USAGE);
    for (const line of refusal) warn(line);
    if (refusal.length > 0) process.exitCode = REFUSED_EXIT;
  },
};

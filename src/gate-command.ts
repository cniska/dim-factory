import { readFileSync } from "node:fs";
import { type Command, Ran, UsageError } from "./cli-contract";
import { warn } from "./cli-warn";
import { judge } from "./gate";
import { checkRange } from "./gate-check-commits";
import { GATE_HOOKS, REFUSED_EXIT } from "./gate-contract";
import { installGate } from "./gate-ops";

const USAGE = `usage: dim gate install --owner <host>/<account> [--owner ...] | dim gate check <range> | dim gate <installed hook: ${GATE_HOOKS.join(" | ")}> [<arguments git passes it>...]`;

function ownersOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg !== "--owner") return [];
    const owner = args[index + 1];
    if (owner === undefined)
      throw new UsageError("--owner needs a value, as in --owner github.com/<account>");
    return [owner];
  });
}

function check(args: readonly string[]) {
  const [range] = args;
  if (!range) throw new UsageError("gate check needs a revision range, e.g. main..HEAD");
  const offenses = checkRange(range, process.cwd());
  return new Ran({ range, offenses }, offenses.length === 0 ? 0 : 1);
}

function judgeHook(hook: string | undefined, rest: string[]): void {
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
}

export const gateCommand: Command = {
  name: "gate",
  usage: USAGE,
  summary:
    "install the commit gate for the owners named, judge a range's subjects, or judge a commit or push for the git hook that calls it",
  raw: (args) => args[0] !== "install" && args[0] !== "check",
  run(args) {
    const [verb, ...rest] = args;
    if (verb === "install") return installGate(ownersOf(rest));
    if (verb === "check") return check(rest);
    return judgeHook(verb, rest);
  },
};

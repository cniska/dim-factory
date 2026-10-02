import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { formatAfterEdit } from "./format-edit";
import { installHooks } from "./hooks";
import { EditPayload, readHookPayload, StartPayload } from "./hooks-payload";
import { ensureSpoolDirs } from "./ingest-spool";
import { projectLine, wireFor } from "./session-start-context";

const USAGE =
  "usage: dim hooks install | dim hooks start < <SessionStart payload> | dim hooks edit < <PostToolUse payload>";

function install() {
  ensureSpoolDirs();
  return installHooks();
}

async function start(): Promise<void> {
  const line = projectLine((await readHookPayload(StartPayload)).cwd);
  if (line !== null) console.log(wireFor(line));
}

async function edit(): Promise<void> {
  formatAfterEdit(await readHookPayload(EditPayload));
}

const VERBS = new Map<string, () => unknown>([
  ["install", install],
  ["start", start],
  ["edit", edit],
]);

const RAW_VERBS = new Set(["start", "edit"]);

export const hooksCommand: Command = {
  name: "hooks",
  usage: USAGE,
  summary:
    "install the session hooks, copying each config aside; start and edit are what the SessionStart and PostToolUse hooks run",
  raw: (args) => RAW_VERBS.has(args[0] ?? ""),
  run(args) {
    const [verb, ...rest] = args;
    const act = verb === undefined ? undefined : VERBS.get(verb);
    if (act === undefined) throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, `dim hooks ${verb}`);
    return act();
  },
};

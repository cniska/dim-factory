import { type Command, UsageError } from "./cli-contract";
import { formatAfterEdit } from "./format-edit";
import { installHooks } from "./hooks";
import { EditPayload, readHookPayload, StartPayload } from "./hooks-payload";
import { ensureSpoolDirs } from "./ingest-spool";
import { projectLine, wireFor } from "./session-start-context";

const USAGE =
  "usage: dim hooks install | dim hooks start < <SessionStart payload> | dim hooks edit < <PostToolUse payload>";

const HOOK_VERBS = ["start", "edit"];

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

export const hooksCommand: Command = {
  name: "hooks",
  usage: USAGE,
  summary:
    "install the session hooks, copying each config aside; start and edit are what the SessionStart and PostToolUse hooks run",
  raw: (args) => HOOK_VERBS.includes(args[0] ?? ""),
  run(args) {
    const [verb] = args;
    if (verb === "install") return install();
    if (verb === "start") return start();
    if (verb === "edit") return edit();
    throw new UsageError(USAGE);
  },
};

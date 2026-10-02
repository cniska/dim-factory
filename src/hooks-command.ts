import { type Command, UsageError } from "./cli-contract";
import { type EditPayload, formatAfterEdit } from "./format-edit";
import { installHooks } from "./hooks";
import { readHookPayload } from "./hooks-payload";
import { startSession } from "./hooks-start";
import { ensureSpoolDirs } from "./ingest-spool";

const USAGE =
  "usage: dim hooks install | dim hooks start < <SessionStart payload> | dim hooks edit < <PostToolUse payload>";

const HOOK_VERBS = ["start", "edit"];

function install() {
  ensureSpoolDirs();
  return installHooks();
}

async function edit(): Promise<void> {
  try {
    formatAfterEdit((await readHookPayload()) as EditPayload);
  } catch {}
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
    if (verb === "start") return startSession();
    if (verb === "edit") return edit();
    throw new UsageError(USAGE);
  },
};

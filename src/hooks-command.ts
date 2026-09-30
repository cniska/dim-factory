import { type Command, UsageError } from "./cli-contract";
import { type EditPayload, formatAfterEdit } from "./format-edit";
import { type HookPlan, installHooks, planHooks } from "./hooks";
import { readHookPayload } from "./hooks-payload";
import { startSession } from "./hooks-start";
import { ensureSpoolDirs } from "./ingest-spool";

const USAGE =
  "usage: dim hooks install | dim hooks start [--tool=codex] < <SessionStart payload> | dim hooks edit < <PostToolUse payload>";

const HOOK_VERBS = ["start", "edit"];

function hookState(plans: HookPlan[]) {
  const pending = plans.filter((plan) => plan.state !== "installed");
  return { installed: plans.length - pending.length, pending };
}

function install() {
  ensureSpoolDirs();
  const report = installHooks();
  return { ...hookState(planHooks()), ...report };
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
    const [verb, ...rest] = args;
    if (verb === "install") return install();
    if (verb === "start") return startSession(rest);
    if (verb === "edit") return edit();
    throw new UsageError(USAGE);
  },
};

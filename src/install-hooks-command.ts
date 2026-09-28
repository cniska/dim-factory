import type { Command } from "./cli-contract";
import { type HookPlan, installHooks, planHooks } from "./hooks";
import { ensureSpoolDirs } from "./ingest-spool";
import { WRITE_NEXT } from "./install-write";

function hookState(plans: HookPlan[]) {
  const pending = plans.filter((plan) => plan.state !== "installed");
  return { installed: plans.length - pending.length, pending };
}

export const installHooksCommand: Command = {
  name: "install-hooks",
  usage: "usage: dim install-hooks [--write]",
  summary: "show the session hooks to add (--write applies them, copying each config aside)",
  run(args) {
    const state = hookState(planHooks());
    if (state.pending.length === 0) return state;
    if (!args.includes("--write")) return { pending: state.pending, next: WRITE_NEXT };
    ensureSpoolDirs();
    const report = installHooks();
    return { ...hookState(planHooks()), ...report };
  },
};

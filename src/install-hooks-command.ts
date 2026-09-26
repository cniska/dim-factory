import type { Command } from "./command";
import { installHooks, planHooks } from "./hooks";
import { WRITE_NEXT } from "./install-write";
import { ensureSpoolDirs } from "./spool";

export const installHooksCommand: Command = {
  name: "install-hooks",
  usage: "usage: dim install-hooks [--write]",
  summary:
    "show the session hooks to add to both tools' config (--write applies them, copying each config aside)",
  run(args) {
    ensureSpoolDirs();
    const plans = planHooks();
    const pending = plans.filter((plan) => plan.state !== "installed");
    if (pending.length === 0) return { installed: plans.length, pending };
    if (!args.includes("--write")) return { pending, next: WRITE_NEXT };
    return { pending, ...installHooks() };
  },
};

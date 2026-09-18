import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "./config-error";
import { appendToJsoncArray, parseJsonc, readJsonc } from "./jsonc";
import { claudeProjectsDir, codexDir, type Env } from "./paths";
import { toolSpoolDir } from "./spool";
import { TOOLS, type Tool } from "./tools";

export type HookPlan = {
  tool: Tool;
  configPath: string;
  event: string;
  command: string;
  present: boolean;
};

/**
 * The whole hook: one redirect into a uniquely named file, no jq, no sqlite, no
 * network, and it always exits 0. A hook that can fail is a hook that can break
 * every session on this machine. `sync` does the work later, under its lock.
 */
export function hookCommand(tool: Tool, env: Env = process.env): string {
  return `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$.json" 2>/dev/null; exit 0`;
}

/**
 * The second SessionStart hook, and the only one that speaks back: its stdout
 * becomes context the session starts with. Absolute, like the launchd agent's
 * `bun`, because a hook does not inherit an interactive shell's PATH; `|| true`
 * and a discarded stderr because this runs before every session and a hook that
 * can fail is a hook that can stop one from starting.
 */
export function wakeCommand(tool: Tool): string {
  return `${dimPath()} wake --tool=${tool} 2>/dev/null || true`;
}

/** The linked `dim`, falling back to the name so a plan reads sensibly where it is not installed. */
export function dimPath(): string {
  return Bun.which("dim") ?? "dim";
}

export function hookConfigPath(tool: Tool, env: Env = process.env): string {
  return tool === "claude"
    ? join(dirname(claudeProjectsDir(env)), "settings.json")
    : join(codexDir(env), "hooks.json");
}

export type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };
type HookConfig = { hooks?: Record<string, HookEntry[]> };

export type WantedHook = { event: string; command: string };

/**
 * The installer and the Codex trust check read this one list, because a hook the
 * trust check stops reporting reads exactly like a hook that is trusted.
 *
 * SessionStart carries two: one writes the event to the spool, one answers with
 * the context the session starts from. They are separate entries so a reader can
 * see which is which, and so one failing cannot silence the other.
 */
export function wantedHooks(tool: Tool, env: Env = process.env): WantedHook[] {
  return [
    { event: "SessionStart", command: hookCommand(tool, env) },
    { event: "SessionStart", command: wakeCommand(tool) },
    { event: "SessionEnd", command: hookCommand(tool, env) },
    { event: "PostToolUse", command: hookCommand(tool, env) },
  ];
}

function readConfig(path: string): HookConfig {
  return readJsonc<HookConfig>(path) ?? {};
}

function hasCommand(entries: HookEntry[], command: string): boolean {
  return entries.some((e) => e.hooks?.some((h) => h.command === command));
}

/** Both tools take the same shape: hooks.<Event>[].hooks[].command. */
export function planHooks(env: Env = process.env): HookPlan[] {
  const plans: HookPlan[] = [];
  for (const tool of TOOLS) {
    const configPath = hookConfigPath(tool, env);
    const config = readConfig(configPath);
    for (const { event, command } of wantedHooks(tool, env)) {
      plans.push({
        tool,
        configPath,
        event,
        command,
        present: hasCommand(config.hooks?.[event] ?? [], command),
      });
    }
  }
  return plans;
}

/**
 * A key written twice resolves to the first copy when the file is edited and to
 * the last when it is read, so an edit can land somewhere nothing will look. The
 * text is read back the way the tools read it, and a command that is not in it
 * refuses the write — otherwise each run appends again to the dead copy, the
 * hook never fires, and the backup of the last good config is overwritten.
 */
function refuseIneffective(text: string, configPath: string, plans: HookPlan[]): void {
  const config = parseJsonc<HookConfig>(text, configPath);
  for (const plan of plans) {
    if (hasCommand(config.hooks?.[plan.event] ?? [], plan.command)) continue;
    throw new ConfigError(
      "unwritable",
      configPath,
      `${configPath}: the ${plan.event} hook would not land where a reader looks, so nothing was written`,
      `hooks.${plan.event}`,
    );
  }
}

export type InstallReport = { written: string[]; alreadyPresent: number; backups: string[] };

/**
 * Append the spool hook to each config, leaving every hook already there alone.
 * The original is copied beside itself first: this edits the file that decides
 * whether the user's sessions start at all.
 */
export function installHooks(env: Env = process.env): InstallReport {
  const report: InstallReport = { written: [], alreadyPresent: 0, backups: [] };
  const byConfig = new Map<string, HookPlan[]>();
  for (const plan of planHooks(env)) {
    const list = byConfig.get(plan.configPath) ?? [];
    list.push(plan);
    byConfig.set(plan.configPath, list);
  }

  // Every config is built and checked before any is written, so a refusal on the
  // second leaves the first alone and the message holds for both.
  const pending: { configPath: string; text: string }[] = [];
  for (const [configPath, plans] of byConfig) {
    const missing = plans.filter((p) => !p.present);
    report.alreadyPresent += plans.length - missing.length;
    if (missing.length === 0) continue;

    let text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    for (const plan of missing) {
      const entry: HookEntry = { hooks: [{ type: "command", command: plan.command }] };
      text = appendToJsoncArray(text, ["hooks", plan.event], entry, configPath);
    }
    refuseIneffective(text, configPath, missing);
    pending.push({ configPath, text });
  }

  for (const { configPath, text } of pending) {
    const present = existsSync(configPath);
    if (present) {
      const backup = `${configPath}.dim-backup`;
      copyFileSync(configPath, backup);
      report.backups.push(backup);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }
    writeFileSync(configPath, text);
    report.written.push(configPath);
  }
  return report;
}

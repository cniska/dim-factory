import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectsDir, codexDir, type Env } from "./paths";
import { type Tool, toolSpoolDir } from "./spool";

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

function configPathFor(tool: Tool, env: Env = process.env): string {
  return tool === "claude"
    ? join(dirname(claudeProjectsDir(env)), "settings.json")
    : join(codexDir(env), "hooks.json");
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };
type HookConfig = { hooks?: Record<string, HookEntry[]> };

function readConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as HookConfig;
}

function hasCommand(entries: HookEntry[], command: string): boolean {
  return entries.some((e) => e.hooks?.some((h) => h.command === command));
}

/** Both tools take the same shape: hooks.<Event>[].hooks[].command. */
export function planHooks(env: Env = process.env): HookPlan[] {
  const plans: HookPlan[] = [];
  for (const tool of ["claude", "codex"] as const) {
    const configPath = configPathFor(tool, env);
    const config = readConfig(configPath);
    const command = hookCommand(tool, env);
    for (const event of ["SessionStart", "SessionEnd"]) {
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

  for (const [configPath, plans] of byConfig) {
    const missing = plans.filter((p) => !p.present);
    report.alreadyPresent += plans.length - missing.length;
    if (missing.length === 0) continue;

    const config = readConfig(configPath);
    config.hooks ??= {};
    for (const plan of missing) {
      const entries = config.hooks[plan.event] ?? [];
      entries.push({ hooks: [{ type: "command", command: plan.command }] });
      config.hooks[plan.event] = entries;
    }

    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    JSON.parse(serialized); // refuse to write anything that will not parse back
    if (existsSync(configPath)) {
      const backup = `${configPath}.dim-backup`;
      copyFileSync(configPath, backup);
      report.backups.push(backup);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }
    writeFileSync(configPath, serialized);
    report.written.push(configPath);
  }
  return report;
}

import { dirname, join } from "node:path";
import type { JSONPath } from "jsonc-parser";
import { ConfigError } from "./config-error";
import { appendToJsoncArray, parseJsonc, setJsoncValue } from "./config-jsonc";
import { readJsonc, readJsoncText, writeJsoncFile } from "./config-jsonc-file";
import { toolSpoolDir } from "./ingest-spool";
import { TOOLS, type Tool } from "./ingest-tools";
import { claudeProjectsDir, codexDir, type Env } from "./paths";

export const HOOK_CONTRACT_VERSION = 2;

const CONTRACT_MARKER = /#\s*dim-hook:(\d+)\s*$/;

function marked(command: string): string {
  return `${command} # dim-hook:${HOOK_CONTRACT_VERSION}`;
}

export function hookContractVersion(command: string): number | null {
  const found = CONTRACT_MARKER.exec(command);
  return found ? Number(found[1]) : null;
}

export type HookKind = "spool" | "wake";

function hookKind(command: string, tool: Tool, env: Env): HookKind | null {
  if (command.includes(toolSpoolDir(tool, env))) return "spool";
  if (command.includes(`wake --tool=${tool}`)) return "wake";
  return null;
}

export type HookPlan = {
  tool: Tool;
  configPath: string;
  event: string;
  kind: HookKind;
  command: string;
  state: "installed" | "stale" | "missing";
  at?: JSONPath;
  installedVersion?: number | null;
};

export function hookCommand(tool: Tool, env: Env = process.env): string {
  return marked(
    `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0`,
  );
}

export function wakeCommand(tool: Tool): string {
  return marked(`${dimPath()} wake --tool=${tool} 2>/dev/null || true`);
}

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

export type WantedHook = { event: string; kind: HookKind; command: string };

export function wantedHooks(tool: Tool, env: Env = process.env): WantedHook[] {
  return [
    { event: "SessionStart", kind: "spool", command: hookCommand(tool, env) },
    { event: "SessionStart", kind: "wake", command: wakeCommand(tool) },
    { event: "SessionEnd", kind: "spool", command: hookCommand(tool, env) },
    { event: "PostToolUse", kind: "spool", command: hookCommand(tool, env) },
  ];
}

function readConfig(path: string): HookConfig {
  return readJsonc<HookConfig>(path) ?? {};
}

function hasCommand(entries: HookEntry[], command: string): boolean {
  return entries.some((e) => e.hooks?.some((h) => h.command === command));
}

function findOwn(
  entries: HookEntry[],
  kind: HookKind,
  tool: Tool,
  env: Env,
): { index: [number, number]; command: string } | null {
  for (const [entry, e] of entries.entries()) {
    for (const [hook, h] of (e.hooks ?? []).entries()) {
      if (h.command && hookKind(h.command, tool, env) === kind) {
        return { index: [entry, hook], command: h.command };
      }
    }
  }
  return null;
}

export function planHooks(env: Env = process.env): HookPlan[] {
  const plans: HookPlan[] = [];
  for (const tool of TOOLS) {
    const configPath = hookConfigPath(tool, env);
    const config = readConfig(configPath);
    for (const { event, kind, command } of wantedHooks(tool, env)) {
      const entries = config.hooks?.[event] ?? [];
      const own = findOwn(entries, kind, tool, env);
      if (own?.command === command) {
        plans.push({ tool, configPath, event, kind, command, state: "installed" });
      } else if (own) {
        plans.push({
          tool,
          configPath,
          event,
          kind,
          command,
          state: "stale",
          at: ["hooks", event, own.index[0], "hooks", own.index[1], "command"],
          installedVersion: hookContractVersion(own.command),
        });
      } else {
        plans.push({ tool, configPath, event, kind, command, state: "missing" });
      }
    }
  }
  return plans;
}

export type HookGaps = { missing: HookPlan[]; stale: HookPlan[] };

export function hookGaps(env: Env = process.env): HookGaps {
  const plans = planHooks(env);
  return {
    missing: plans.filter((p) => p.state === "missing"),
    stale: plans.filter((p) => p.state === "stale"),
  };
}

export type HooksNotCurrentCode = "hooks_missing" | "hooks_stale";

export class HooksNotCurrent extends Error {
  constructor(
    readonly code: HooksNotCurrentCode,
    message: string,
  ) {
    super(message);
  }
}

const INSTALL = "the owner installs them with `dim install-hooks --write`";

export function requireCurrentHooks(env: Env = process.env): void {
  const gaps = hookGaps(env);
  if (gaps.missing.length > 0) {
    const where = gaps.missing.map((p) => `${p.tool} ${p.event}`).join(", ");
    throw new HooksNotCurrent(
      "hooks_missing",
      `${gaps.missing.length} session hooks are not installed (${where}), so nothing would be recorded; ${INSTALL}`,
    );
  }
  if (gaps.stale.length > 0) {
    const where = gaps.stale
      .map((p) => `${p.tool} ${p.event}: ${p.installedVersion ?? "unmarked"}`)
      .join(", ");
    throw new HooksNotCurrent(
      "hooks_stale",
      `${gaps.stale.length} session hooks are written against a contract older than ${HOOK_CONTRACT_VERSION} ` +
        `(${where}), so what they record is not what is read back; ${INSTALL}`,
    );
  }
}

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

export type InstallReport = {
  written: string[];
  alreadyPresent: number;
  refreshed: number;
  backups: string[];
};

export function installHooks(env: Env = process.env): InstallReport {
  const report: InstallReport = { written: [], alreadyPresent: 0, refreshed: 0, backups: [] };
  const byConfig = new Map<string, HookPlan[]>();
  for (const plan of planHooks(env)) {
    const list = byConfig.get(plan.configPath) ?? [];
    list.push(plan);
    byConfig.set(plan.configPath, list);
  }

  const pending: { configPath: string; text: string }[] = [];
  for (const [configPath, plans] of byConfig) {
    const stale = plans.filter((p) => p.state === "stale");
    const missing = plans.filter((p) => p.state === "missing");
    report.alreadyPresent += plans.length - stale.length - missing.length;
    if (stale.length === 0 && missing.length === 0) continue;

    let text = readJsoncText(configPath);
    for (const plan of stale) {
      text = setJsoncValue(text, plan.at as JSONPath, plan.command, configPath);
    }
    for (const plan of missing) {
      const entry: HookEntry = { hooks: [{ type: "command", command: plan.command }] };
      text = appendToJsoncArray(text, ["hooks", plan.event], entry, configPath);
    }
    refuseIneffective(text, configPath, [...stale, ...missing]);
    report.refreshed += stale.length;
    pending.push({ configPath, text });
  }

  for (const { configPath, text } of pending) {
    const backup = writeJsoncFile(configPath, text);
    if (backup) report.backups.push(backup);
    report.written.push(configPath);
  }
  return report;
}

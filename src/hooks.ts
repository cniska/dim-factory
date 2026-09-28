import { dirname, join } from "node:path";
import type { JSONPath } from "jsonc-parser";
import { ConfigError } from "./config-error";
import { appendToJsoncArray, parseJsonc, setJsoncValue } from "./config-jsonc";
import { readJsonc, readJsoncText, writeJsoncFile } from "./config-jsonc-file";
import { installedHarnesses } from "./harness-installed";
import {
  entryFor,
  HOOK_CONTRACT_VERSION,
  type HookEntry,
  type HookHandler,
  type HookKind,
  hookCommand,
  hookContractVersion,
  unmarked,
  type WantedHook,
  wantedHooks,
} from "./hook-commands";
import { toolSpoolDir } from "./ingest-spool";
import type { Tool } from "./ingest-tools";
import { claudeProjectsDir, codexDir, type Env, grokDir } from "./paths";

function hookKind(command: string, tool: Tool, env: Env): HookKind | null {
  const bare = unmarked(command);
  if (bare === unmarked(hookCommand(tool, env))) return "spool";
  if (bare === unmarked(hookCommand(tool, env, "SessionStart"))) return "spool";
  if (bare === `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$.json" 2>/dev/null; exit 0`) return "spool";
  const spool = `/spool/${tool}/$(date +%s%N)-$$`;
  if (
    hookContractVersion(command) !== null &&
    bare.startsWith('cat > "') &&
    [`${spool}.json" 2>/dev/null; exit 0`, `${spool}-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0`].some(
      (suffix) => bare.endsWith(suffix),
    )
  )
    return "spool";
  if (new RegExp(`^(?:\\S*/)?dim wake --tool=${tool} 2>/dev/null \\|\\| true$`).test(bare)) return "wake";
  if (/^(?:\S*\/)?dim format-edit 2>\/dev\/null \|\| true$/.test(bare)) return "format";
  return null;
}

export type HookRefresh = { at: JSONPath; value?: unknown; append?: HookEntry };

export type HookPlan = {
  tool: Tool;
  configPath: string;
  event: string;
  kind: HookKind;
  command: string;
  matcher?: string;
  state: "installed" | "stale" | "missing";
  outdated?: "command" | "matcher";
  refresh?: HookRefresh;
  installedVersion?: number | null;
};

export function hookConfigPath(tool: Tool, env: Env = process.env): string {
  if (tool === "claude") return join(dirname(claudeProjectsDir(env)), "settings.json");
  if (tool === "grok") return join(grokDir(env), "hooks", "dim.json");
  return join(codexDir(env), "hooks.json");
}

type HookConfig = { hooks?: Record<string, HookEntry[]> };

function readConfig(path: string): HookConfig {
  return readJsonc<HookConfig>(path) ?? {};
}

function hasCommand(entries: HookEntry[], command: string, matcher: string | undefined): boolean {
  return entries.some((e) => e.matcher === matcher && e.hooks?.some((h) => h.command === command));
}

type OwnHook = { entry: number; hook: number; within: HookEntry; handler: HookHandler; command: string };

function findOwn(entries: HookEntry[], kind: HookKind, tool: Tool, env: Env): OwnHook | null {
  for (const [entry, within] of entries.entries()) {
    for (const [hook, handler] of (within.hooks ?? []).entries()) {
      if (handler.command && hookKind(handler.command, tool, env) === kind) {
        return { entry, hook, within, handler, command: handler.command };
      }
    }
  }
  return null;
}

function refreshOf(own: OwnHook, event: string, wanted: WantedHook): HookRefresh {
  const entryAt = ["hooks", event, own.entry];
  if (own.within.matcher === wanted.matcher) {
    return { at: [...entryAt, "hooks", own.hook, "command"], value: wanted.command };
  }
  const handler = { ...own.handler, command: wanted.command };
  if (own.within.hooks?.length === 1) {
    const { matcher: _, ...rest } = own.within;
    return { at: entryAt, value: { ...entryFor(wanted.matcher, handler), ...rest, hooks: [handler] } };
  }
  return { at: [...entryAt, "hooks", own.hook], append: entryFor(wanted.matcher, handler) };
}

export function planHooks(env: Env = process.env): HookPlan[] {
  const plans: HookPlan[] = [];
  for (const tool of installedHarnesses(env)) {
    const configPath = hookConfigPath(tool, env);
    const config = readConfig(configPath);
    for (const wanted of wantedHooks(tool, env)) {
      const { event, kind, command, matcher } = wanted;
      const planned = { tool, configPath, event, kind, command, matcher };
      const own = findOwn(config.hooks?.[event] ?? [], kind, tool, env);
      if (!own) {
        plans.push({ ...planned, state: "missing" });
      } else if (own.command === command && own.within.matcher === matcher) {
        plans.push({ ...planned, state: "installed" });
      } else {
        plans.push({
          ...planned,
          state: "stale",
          outdated: own.command === command ? "matcher" : "command",
          refresh: refreshOf(own, event, wanted),
          installedVersion: hookContractVersion(own.command),
        });
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

export function outdatedLabel(plan: HookPlan): string {
  const what = plan.outdated === "matcher" ? "matcher" : (plan.installedVersion ?? "unmarked");
  return `${plan.event}: ${what}`;
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
    const where = gaps.stale.map((p) => `${p.tool} ${outdatedLabel(p)}`).join(", ");
    throw new HooksNotCurrent(
      "hooks_stale",
      `${gaps.stale.length} session hooks differ from what contract ${HOOK_CONTRACT_VERSION} installs ` +
        `(${where}), so what they record is not what is read back; ${INSTALL}`,
    );
  }
}

function refuseIneffective(text: string, configPath: string, plans: HookPlan[]): void {
  const config = parseJsonc<HookConfig>(text, configPath);
  for (const plan of plans) {
    if (hasCommand(config.hooks?.[plan.event] ?? [], plan.command, plan.matcher)) continue;
    throw new ConfigError(
      "unwritable",
      configPath,
      `${configPath}: the ${plan.event} hook would not land where a reader looks, so nothing was written`,
      `hooks.${plan.event}`,
    );
  }
}

function removalsLast(a: HookRefresh, b: HookRefresh): number {
  const removal = (r: HookRefresh) => (r.append ? 1 : 0);
  if (removal(a) !== removal(b)) return removal(a) - removal(b);
  return removal(a) === 1 ? Number(b.at.at(-1)) - Number(a.at.at(-1)) : 0;
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
    const refreshes = stale.map((plan) => plan.refresh as HookRefresh).sort(removalsLast);
    for (const refresh of refreshes) {
      text = setJsoncValue(text, refresh.at, refresh.value, configPath);
    }
    for (const plan of stale) {
      if (plan.refresh?.append) {
        text = appendToJsoncArray(text, ["hooks", plan.event], plan.refresh.append, configPath);
      }
    }
    for (const plan of missing) {
      const entry = entryFor(plan.matcher, { type: "command", command: plan.command });
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

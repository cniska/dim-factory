import type { JSONPath } from "jsonc-parser";
import { refuseConfig } from "./config-error";
import { appendToJsoncArray, parseJsonc, removeJsoncValue, setJsoncValue } from "./config-jsonc";
import { readJsonc, readJsoncText, writeJsoncFile } from "./config-jsonc-file";
import type { HarnessName } from "./harness-contract";
import { installedHarnesses } from "./harness-ops";
import {
  entryFor,
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
import type { Env } from "./paths";

function hookKind(command: string, tool: HarnessName, env: Env): HookKind | null {
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
  if (new RegExp(`^(?:\\S*/)?dim hooks start(?: --tool=${tool})? 2>/dev/null \\|\\| true$`).test(bare))
    return "start";
  if (/^(?:\S*\/)?dim hooks edit 2>\/dev\/null \|\| true$/.test(bare)) return "edit";
  return null;
}

type HookRemoval = { event: string; entry: number; hook: number };

export type HookRefresh =
  | { kind: "set"; at: JSONPath; value: unknown }
  | { kind: "move"; remove: HookRemoval; append: HookEntry }
  | { kind: "remove"; remove: HookRemoval };

export type HookPlan = {
  tool: HarnessName;
  configPath: string;
  event: string;
  kind: HookKind;
  command: string;
  matcher?: string;
  state: "installed" | "stale" | "missing" | "retired";
  outdated?: "command" | "matcher";
  refresh?: HookRefresh;
  installedVersion?: number | null;
};

type HookConfig = { hooks?: Record<string, HookEntry[]> };

function readConfig(path: string): HookConfig {
  return readJsonc<HookConfig>(path) ?? {};
}

function hasCommand(entries: HookEntry[], command: string, matcher: string | undefined): boolean {
  return entries.some((e) => e.matcher === matcher && e.hooks?.some((h) => h.command === command));
}

type OwnHook = { entry: number; hook: number; within: HookEntry; handler: HookHandler; command: string };

function findOwn(entries: HookEntry[], kind: HookKind, tool: HarnessName, env: Env): OwnHook | null {
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
    return { kind: "set", at: [...entryAt, "hooks", own.hook, "command"], value: wanted.command };
  }
  const handler = { ...own.handler, command: wanted.command };
  if (own.within.hooks?.length === 1) {
    const { matcher: _, ...rest } = own.within;
    return {
      kind: "set",
      at: entryAt,
      value: { ...entryFor(wanted.matcher, handler), ...rest, hooks: [handler] },
    };
  }
  return {
    kind: "move",
    remove: { event, entry: own.entry, hook: own.hook },
    append: entryFor(wanted.matcher, handler),
  };
}

type OwnHandler = OwnHook & { event: string; kind: HookKind };

function ownHandlers(config: HookConfig, tool: HarnessName, env: Env): OwnHandler[] {
  return Object.entries(config.hooks ?? {}).flatMap(([event, entries]) =>
    entries.flatMap((within, entry) =>
      (within.hooks ?? []).flatMap((handler, hook) => {
        const kind = handler.command ? hookKind(handler.command, tool, env) : null;
        return handler.command && kind !== null
          ? [{ event, kind, entry, hook, within, handler, command: handler.command }]
          : [];
      }),
    ),
  );
}

export function planHooks(env: Env = process.env): HookPlan[] {
  const plans: HookPlan[] = [];
  for (const harness of installedHarnesses(env)) {
    const tool = harness.name;
    const configPath = harness.hookConfig(env);
    const config = readConfig(configPath);
    const claimed = new Set<string>();
    for (const wanted of wantedHooks(tool, env)) {
      const { event, kind, command, matcher } = wanted;
      const planned = { tool, configPath, event, kind, command, matcher };
      const own = findOwn(config.hooks?.[event] ?? [], kind, tool, env);
      if (own) claimed.add(`${event}:${own.entry}:${own.hook}`);
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
    for (const own of ownHandlers(config, tool, env)) {
      if (claimed.has(`${own.event}:${own.entry}:${own.hook}`)) continue;
      plans.push({
        tool,
        configPath,
        event: own.event,
        kind: own.kind,
        command: own.command,
        matcher: own.within.matcher,
        state: "retired",
        refresh: { kind: "remove", remove: { event: own.event, entry: own.entry, hook: own.hook } },
      });
    }
  }
  return plans;
}

export type HookGaps = { missing: HookPlan[]; stale: HookPlan[]; retired: HookPlan[] };

export function hookGaps(env: Env = process.env): HookGaps {
  const plans = planHooks(env);
  return {
    missing: plans.filter((p) => p.state === "missing"),
    stale: plans.filter((p) => p.state === "stale"),
    retired: plans.filter((p) => p.state === "retired"),
  };
}

export function outdatedLabel(plan: HookPlan): string {
  const what = plan.outdated === "matcher" ? "matcher" : (plan.installedVersion ?? "unmarked");
  return `${plan.event}: ${what}`;
}

function refuseIneffective(text: string, configPath: string, plans: HookPlan[]): void {
  const config = parseJsonc<HookConfig>(text, configPath);
  for (const plan of plans) {
    if (hasCommand(config.hooks?.[plan.event] ?? [], plan.command, plan.matcher)) continue;
    throw refuseConfig("config_unwritable", {
      path: configPath,
      at: `hooks.${plan.event}`,
      event: plan.event,
    });
  }
}

function applyRemovals(text: string, removals: readonly HookRemoval[], configPath: string): string {
  if (removals.length === 0) return text;
  const config = parseJsonc<HookConfig>(text, configPath);
  const byEntry = new Map<string, HookRemoval[]>();
  for (const removal of removals) {
    const key = JSON.stringify([removal.event, removal.entry]);
    byEntry.set(key, [...(byEntry.get(key) ?? []), removal]);
  }
  const entries = [...byEntry.values()].sort((a, b) => (b[0]?.entry ?? 0) - (a[0]?.entry ?? 0));
  let edited = text;
  for (const inEntry of entries) {
    const [first] = inEntry;
    if (first === undefined) continue;
    const handlers = config.hooks?.[first.event]?.[first.entry]?.hooks?.length ?? 0;
    if (inEntry.length === handlers) {
      edited = removeJsoncValue(edited, ["hooks", first.event, first.entry], configPath);
      continue;
    }
    for (const { hook } of [...inEntry].sort((a, b) => b.hook - a.hook)) {
      edited = removeJsoncValue(edited, ["hooks", first.event, first.entry, "hooks", hook], configPath);
    }
  }
  return edited;
}

export type InstallReport = {
  written: string[];
  added: number;
  alreadyPresent: number;
  refreshed: number;
  retired: number;
  backups: string[];
};

export function installHooks(env: Env = process.env): InstallReport {
  const report: InstallReport = {
    written: [],
    added: 0,
    alreadyPresent: 0,
    refreshed: 0,
    retired: 0,
    backups: [],
  };
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
    const retired = plans.filter((p) => p.state === "retired");
    report.alreadyPresent += plans.filter((p) => p.state === "installed").length;
    if (stale.length === 0 && missing.length === 0 && retired.length === 0) continue;

    const refreshes = [...stale, ...retired].flatMap((plan) => (plan.refresh ? [plan.refresh] : []));
    let text = readJsoncText(configPath);
    for (const refresh of refreshes) {
      if (refresh.kind === "set") text = setJsoncValue(text, refresh.at, refresh.value, configPath);
    }
    text = applyRemovals(
      text,
      refreshes.flatMap((refresh) => (refresh.kind === "set" ? [] : [refresh.remove])),
      configPath,
    );
    for (const plan of stale) {
      if (plan.refresh?.kind === "move") {
        text = appendToJsoncArray(text, ["hooks", plan.event], plan.refresh.append, configPath);
      }
    }
    for (const plan of missing) {
      const entry = entryFor(plan.matcher, { type: "command", command: plan.command });
      text = appendToJsoncArray(text, ["hooks", plan.event], entry, configPath);
    }
    refuseIneffective(text, configPath, [...stale, ...missing]);
    report.added += missing.length;
    report.refreshed += stale.length;
    report.retired += retired.length;
    pending.push({ configPath, text });
  }

  for (const { configPath, text } of pending) {
    const backup = writeJsoncFile(configPath, text);
    if (backup) report.backups.push(backup);
    report.written.push(configPath);
  }
  return report;
}

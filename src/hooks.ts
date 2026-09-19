import { dirname, join } from "node:path";
import type { JSONPath } from "jsonc-parser";
import { ConfigError } from "./config-error";
import { appendToJsoncArray, parseJsonc, setJsoncValue } from "./jsonc";
import { readJsonc, readJsoncText, writeJsoncFile } from "./jsonc-file";
import { claudeProjectsDir, codexDir, type Env } from "./paths";
import { toolSpoolDir } from "./spool";
import { TOOLS, type Tool } from "./tools";

/**
 * Bumped whenever an installed command's text changes. It rides in the command as
 * a shell comment because the tool's config is the only record of what a session
 * will run, and a hook written against an older contract is otherwise
 * indistinguishable from the current one.
 */
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

/**
 * Read off what a command does rather than off its text matching in full: one
 * whose text still matched would be the current command, and what this has to
 * recognize is one that no longer does.
 */
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
  /** Where the out-of-date command sits, for the installer to write over. Stale only. */
  at?: JSONPath;
  /** The contract the installed command carries, null where it carries none. Stale only. */
  installedVersion?: number | null;
};

/**
 * The whole hook: one redirect into a uniquely named file, no jq, no sqlite, no
 * network, and it always exits 0. A hook that can fail is a hook that can break
 * every session on this machine. `sync` does the work later, under its lock.
 */
export function hookCommand(tool: Tool, env: Env = process.env): string {
  // The worker's name rides in the filename because the hook runs in the environment the
  // factory started the worker in, so which worker wrote a session's first payload is
  // recorded by the harness rather than stated by anything the model can reach. Empty for a
  // session nothing spawned, which is a session belonging to no worker and not an error.
  return marked(
    `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0`,
  );
}

/**
 * The second SessionStart hook, and the only one that speaks back: its stdout
 * becomes context the session starts with. Absolute, like the launchd agent's
 * `bun`, because a hook does not inherit an interactive shell's PATH; `|| true`
 * and a discarded stderr because this runs before every session and a hook that
 * can fail is a hook that can stop one from starting.
 */
export function wakeCommand(tool: Tool): string {
  return marked(`${dimPath()} wake --tool=${tool} 2>/dev/null || true`);
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

export type WantedHook = { event: string; kind: HookKind; command: string };

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

/** The first command at this event that is dim's own, whatever contract wrote it. */
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

/** Both tools take the same shape: hooks.<Event>[].hooks[].command. */
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

/** What is not collecting: a hook nothing wrote, and one written against an older contract. */
export type HookGaps = { missing: HookPlan[]; stale: HookPlan[] };

export function hookGaps(env: Env = process.env): HookGaps {
  const plans = planHooks(env);
  return {
    missing: plans.filter((p) => p.state === "missing"),
    stale: plans.filter((p) => p.state === "stale"),
  };
}

export type HooksNotCurrentCode = "hooks_missing" | "hooks_stale";

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class HooksNotCurrent extends Error {
  constructor(
    readonly code: HooksNotCurrentCode,
    message: string,
  ) {
    super(message);
  }
}

const INSTALL = "the owner installs them with `dim install-hooks --write`";

/**
 * Missing is reported first because the two failures are not the same size: a hook
 * nothing wrote records nothing at all, where an older contract still writes and writes
 * a shape nothing downstream reads. A config that cannot be parsed throws its own
 * ConfigError, which is a machine that cannot be proven collecting either.
 */
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

export type InstallReport = {
  written: string[];
  alreadyPresent: number;
  refreshed: number;
  backups: string[];
};

/**
 * Bring each config up to the current contract, leaving every hook that is not
 * dim's alone. An out-of-date command is written over where it sits rather than
 * added beside: both would fire, and the older one would keep writing whatever
 * the bump was made to stop.
 */
export function installHooks(env: Env = process.env): InstallReport {
  const report: InstallReport = { written: [], alreadyPresent: 0, refreshed: 0, backups: [] };
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
    const stale = plans.filter((p) => p.state === "stale");
    const missing = plans.filter((p) => p.state === "missing");
    report.alreadyPresent += plans.length - stale.length - missing.length;
    if (stale.length === 0 && missing.length === 0) continue;

    let text = readJsoncText(configPath);
    // Rewrites first: an append changes an array's length, and every position a
    // stale plan holds was read before any of this config was touched.
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

import { EDIT_TOOLS } from "./format-edit";
import { toolSpoolDir } from "./ingest-spool";
import type { Tool } from "./ingest-tools";
import type { Env } from "./paths";

export const HOOK_CONTRACT_VERSION = 3;

const CONTRACT_MARKER = /#\s*dim-hook:(\d+)\s*$/;

function marked(command: string): string {
  return `${command} # dim-hook:${HOOK_CONTRACT_VERSION}`;
}

export function unmarked(command: string): string {
  return command.replace(CONTRACT_MARKER, "").trimEnd();
}

export function hookContractVersion(command: string): number | null {
  const found = CONTRACT_MARKER.exec(command);
  return found ? Number(found[1]) : null;
}

export type HookKind = "spool" | "wake" | "format";

export function hookCommand(tool: Tool, env: Env = process.env, event?: string): string {
  const harnessPid = event === "SessionStart" ? "-$PPID" : "";
  return marked(
    `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$${harnessPid}-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0`,
  );
}

export function wakeCommand(tool: Tool): string {
  return marked(`${dimPath()} wake --tool=${tool} 2>/dev/null || true`);
}

export function formatEditCommand(): string {
  return marked(`${dimPath()} format-edit 2>/dev/null || true`);
}

export function dimPath(): string {
  return Bun.which("dim") ?? "dim";
}

export type HookHandler = { type?: string; command?: string; timeout?: number };
export type HookEntry = { matcher?: string; hooks?: HookHandler[] };

export type WantedHook = { event: string; kind: HookKind; command: string; matcher?: string };

export function wantedHooks(tool: Tool, env: Env = process.env): WantedHook[] {
  const spool = (event: string): WantedHook => ({
    event,
    kind: "spool",
    command: hookCommand(tool, env, event),
  });
  if (tool === "grok") return [spool("SessionStart"), spool("SessionEnd"), spool("PostToolUse")];
  return [
    spool("SessionStart"),
    { event: "SessionStart", kind: "wake", command: wakeCommand(tool) },
    spool("SessionEnd"),
    spool("PostToolUse"),
    {
      event: "PostToolUse",
      kind: "format",
      command: formatEditCommand(),
      matcher: EDIT_TOOLS[tool].join("|"),
    },
  ];
}

export function entryFor(matcher: string | undefined, handler: HookHandler): HookEntry {
  return matcher === undefined ? { hooks: [handler] } : { matcher, hooks: [handler] };
}

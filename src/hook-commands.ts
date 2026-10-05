import { z } from "zod";
import { HARNESSES, type HarnessName } from "./harness-contract";
import { toolSpoolDir } from "./ingest-spool";
import type { Env } from "./paths";

export const HOOK_CONTRACT_VERSION = 4;

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

export type HookKind = "spool" | "start" | "edit";

export function hookCommand(tool: HarnessName, env: Env = process.env, event?: string): string {
  const harnessPid = event === "SessionStart" ? "-$PPID" : "";
  return marked(
    `cat > "${toolSpoolDir(tool, env)}/$(date +%s%N)-$$${harnessPid}-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0`,
  );
}

export function startCommand(): string {
  return marked(`${dimPath()} hooks start 2>/dev/null || true`);
}

export function editCommand(): string {
  return marked(`${dimPath()} hooks edit 2>/dev/null || true`);
}

export function dimPath(): string {
  return Bun.which("dim") ?? "dim";
}

export const HookHandler = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
});
export type HookHandler = z.infer<typeof HookHandler>;

export const HookEntry = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(HookHandler).optional(),
});
export type HookEntry = z.infer<typeof HookEntry>;

export const HookConfig = z.looseObject({ hooks: z.record(z.string(), z.array(HookEntry)).optional() });
export type HookConfig = z.infer<typeof HookConfig>;

export type WantedHook = { event: string; kind: HookKind; command: string; matcher?: string };

export function wantedHooks(tool: HarnessName, env: Env = process.env): WantedHook[] {
  const spool = (event: string): WantedHook => ({
    event,
    kind: "spool",
    command: hookCommand(tool, env, event),
  });
  return [
    spool("SessionStart"),
    { event: "SessionStart", kind: "start", command: startCommand() },
    spool("SessionEnd"),
    {
      event: "PostToolUse",
      kind: "edit",
      command: editCommand(),
      matcher: HARNESSES[tool].editTools.join("|"),
    },
  ];
}

export function entryFor(matcher: string | undefined, handler: HookHandler): HookEntry {
  return matcher === undefined ? { hooks: [handler] } : { matcher, hooks: [handler] };
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry } from "./claude-transcript";
import type { HarnessScript, HarnessTurn } from "./harness-script";
import { STATION_ROLES, type StationRole } from "./vocabulary";

export type Invocation = {
  readonly role: StationRole;
  readonly turn: number;
  readonly sessionId: string;
  readonly resumed: string | null;
  readonly forked: boolean;
  readonly model: string | null;
  readonly prompt: string;
  readonly cwd: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
  readonly history: readonly TranscriptEntry[];
};

const scriptPath = (state: string) => join(state, "script.json");
const consumedPath = (state: string) => join(state, "consumed.json");
const invocationsPath = (state: string) => join(state, "invocations.jsonl");
const sessionRolePath = (state: string, sessionId: string) => join(state, "sessions", `${sessionId}.role`);
export const signalPath = (state: string, name: string) => join(state, "signals", name);
export const releasePath = (state: string, name: string) => join(state, "releases", name);

export function writeHarnessScript(state: string, script: HarnessScript): void {
  writeFileSync(scriptPath(state), JSON.stringify(script));
  writeFileSync(consumedPath(state), "{}");
}

export function takeTurn(
  state: string,
  role: StationRole,
): { readonly turn: number; readonly acts: HarnessTurn } {
  const script = JSON.parse(readFileSync(scriptPath(state), "utf8")) as HarnessScript;
  const consumed = JSON.parse(readFileSync(consumedPath(state), "utf8")) as Partial<
    Record<StationRole, number>
  >;
  const turn = consumed[role] ?? 0;
  const acts = script[role]?.[turn];
  if (!acts) throw new Error(`the script holds no turn ${turn + 1} for the ${role}`);
  writeFileSync(consumedPath(state), JSON.stringify({ ...consumed, [role]: turn + 1 }));
  return { turn, acts };
}

export function rememberRole(state: string, sessionId: string, role: StationRole): void {
  mkdirSync(join(state, "sessions"), { recursive: true });
  writeFileSync(sessionRolePath(state, sessionId), role);
}

export function roleOf(state: string, sessionId: string): StationRole | null {
  const path = sessionRolePath(state, sessionId);
  if (!existsSync(path)) return null;
  const written = readFileSync(path, "utf8");
  return STATION_ROLES.find((role) => role === written) ?? null;
}

export function recordInvocation(state: string, invocation: Invocation): void {
  appendFileSync(invocationsPath(state), `${JSON.stringify(invocation)}\n`);
}

export function invocations(state: string): readonly Invocation[] {
  if (!existsSync(invocationsPath(state))) return [];
  return readFileSync(invocationsPath(state), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

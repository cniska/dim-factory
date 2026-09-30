import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerAct } from "./worker-acts";

export type Role = "planner" | "builder" | "reviewer";

export type HarnessAct =
  | WorkerAct
  | { act: "sh"; command: string }
  | { act: "write"; path: string; content: string }
  | { act: "say"; text: string }
  | { act: "signal"; name: string }
  | { act: "wait"; name: string }
  | { act: "build-remaining"; artifact: string }
  | { act: "die" }
  | { act: "limit"; resetsAt: string };

export type HarnessTurn = HarnessAct[];

export type HarnessScript = Partial<Record<Role, HarnessTurn[]>>;

export type Invocation = {
  role: Role;
  turn: number;
  sessionId: string;
  resumed: string | null;
  forked: boolean;
  model: string | null;
  prompt: string;
  cwd: string;
  pid: number;
  env: Record<string, string>;
  history: TranscriptEntry[];
};

export type TranscriptEntry =
  | { type: "user"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; output: string }
  | { type: "assistant"; text: string };

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

export function takeTurn(state: string, role: Role): { turn: number; acts: HarnessTurn } {
  const script = JSON.parse(readFileSync(scriptPath(state), "utf8")) as HarnessScript;
  const consumed = JSON.parse(readFileSync(consumedPath(state), "utf8")) as Partial<Record<Role, number>>;
  const turn = consumed[role] ?? 0;
  const acts = script[role]?.[turn];
  if (!acts) throw new Error(`the script holds no turn ${turn + 1} for the ${role}`);
  writeFileSync(consumedPath(state), JSON.stringify({ ...consumed, [role]: turn + 1 }));
  return { turn, acts };
}

export function rememberRole(state: string, sessionId: string, role: Role): void {
  mkdirSync(join(state, "sessions"), { recursive: true });
  writeFileSync(sessionRolePath(state, sessionId), role);
}

export function roleOf(state: string, sessionId: string): Role | undefined {
  const path = sessionRolePath(state, sessionId);
  return existsSync(path) ? (readFileSync(path, "utf8") as Role) : undefined;
}

export function recordInvocation(state: string, invocation: Invocation): void {
  appendFileSync(invocationsPath(state), `${JSON.stringify(invocation)}\n`);
}

export function invocations(state: string): Invocation[] {
  if (!existsSync(invocationsPath(state))) return [];
  return readFileSync(invocationsPath(state), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

type ClaudeBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
};

type ClaudeLine = { type: string; message?: { role: string; content: string | ClaudeBlock[] } };

function entriesOf(line: ClaudeLine): TranscriptEntry[] {
  const content = line.message?.content;
  if (content === undefined) return [];
  if (typeof content === "string") return line.type === "user" ? [{ type: "user", text: content }] : [];
  return content.flatMap((block): TranscriptEntry[] => {
    if (block.type === "text") return [{ type: "assistant", text: block.text ?? "" }];
    if (block.type === "tool_use")
      return [{ type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input ?? {} }];
    if (block.type === "tool_result")
      return [{ type: "tool_result", id: block.tool_use_id ?? "", output: block.content ?? "" }];
    return [];
  });
}

export function claudeLine(sessionId: string, cwd: string, entry: TranscriptEntry): Record<string, unknown> {
  const base = { sessionId, cwd, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() };
  switch (entry.type) {
    case "user":
      return { ...base, type: "user", message: { role: "user", content: entry.text } };
    case "assistant":
      return {
        ...base,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: entry.text }] },
      };
    case "tool_use":
      return {
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: entry.id, name: entry.name, input: entry.input }],
        },
      };
    case "tool_result":
      return {
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: entry.id, content: entry.output }],
        },
      };
  }
}

export function readTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => entriesOf(JSON.parse(line) as ClaudeLine));
}

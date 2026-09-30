#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { type ClaudeHooks, fireHooksSync, mergeHooks, userHooks } from "./claude-hooks";
import {
  claudeLine,
  type HarnessAct,
  type Invocation,
  type Role,
  readTranscript,
  recordInvocation,
  releasePath,
  rememberRole,
  roleOf,
  signalPath,
  type TranscriptEntry,
  takeTurn,
  transcriptPath,
} from "./scripted-harness-state";
import { type Dim, dimArgs } from "./worker-acts";

type Flags = {
  resume: string | null;
  fork: boolean;
  sessionId: string | null;
  model: string | null;
  settings: { hooks?: ClaudeHooks } | null;
  settingSources: string | null;
  prompt: string;
};

const VALUED = new Set([
  "--output-format",
  "--permission-mode",
  "--setting-sources",
  "--plugin-dir",
  "--settings",
  "--json-schema",
  "--add-dir",
  "--model",
  "--resume",
  "--session-id",
]);

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    resume: null,
    fork: false,
    sessionId: null,
    model: null,
    settings: null,
    settingSources: null,
    prompt: "",
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--fork-session") flags.fork = true;
    else if (VALUED.has(arg)) {
      const value = argv[++i] ?? "";
      if (arg === "--resume") flags.resume = value;
      if (arg === "--session-id") flags.sessionId = value;
      if (arg === "--model") flags.model = value;
      if (arg === "--settings") flags.settings = JSON.parse(value);
      if (arg === "--setting-sources") flags.settingSources = value;
    } else if (!arg.startsWith("-")) positional.push(arg);
  }
  flags.prompt = positional.join(" ");
  return flags;
}

const SKILL_ROLES: [string, Role][] = [
  ["dim-plan", "planner"],
  ["dim-build", "builder"],
  ["dim-review", "reviewer"],
];

function roleNamedIn(prompt: string): Role | undefined {
  return SKILL_ROLES.find(([skill]) => prompt.includes(skill))?.[1];
}

const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

const [state, ...argv] = Bun.argv.slice(2) as [string, ...string[]];
const flags = parseFlags(argv);
const cwd = process.cwd();
const home = process.env.HOME as string;
const env = { ...process.env } as Record<string, string>;

if (!flags.prompt && !process.stdin.isTTY) flags.prompt = (await Bun.stdin.text()).trim();

if (flags.resume && !existsSync(transcriptPath(home, cwd, flags.resume))) {
  process.stderr.write(`No conversation found with session ID: ${flags.resume}\n`);
  process.exit(1);
}

const sessionId = flags.resume && !flags.fork ? flags.resume : (flags.sessionId ?? crypto.randomUUID());
const transcript = transcriptPath(home, cwd, sessionId);
mkdirSync(dirname(transcript), { recursive: true });
if (flags.resume && flags.fork) copyFileSync(transcriptPath(home, cwd, flags.resume), transcript);
const history = readTranscript(transcript);

const role = (flags.resume && roleOf(state, flags.resume)) || roleNamedIn(flags.prompt);
if (!role) {
  process.stderr.write("scripted claude: the brief names no station skill\n");
  process.exit(3);
}
rememberRole(state, sessionId, role);

const hooks = mergeHooks(flags.settingSources === "" ? {} : userHooks(home), flags.settings?.hooks ?? {});
const fire = (event: string, payload: Record<string, unknown> = {}, tool?: string) =>
  fireHooksSync(hooks, event, { session_id: sessionId, ...payload }, env, cwd, tool);

const { turn, acts } = takeTurn(state, role);
const invocation: Invocation = {
  role,
  turn,
  sessionId,
  resumed: flags.resume,
  forked: flags.fork,
  model: flags.model,
  prompt: flags.prompt,
  cwd,
  pid: process.pid,
  env,
  history,
};
recordInvocation(state, invocation);

const record = (entry: TranscriptEntry) =>
  appendFileSync(transcript, `${JSON.stringify(claudeLine(sessionId, cwd, entry))}\n`);

emit({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", model: flags.model });
fire("SessionStart", { source: flags.resume ? "resume" : "startup" });
record({ type: "user", text: flags.prompt });

const scratch = mkdtempSync(`${env.TMPDIR ?? tmpdir()}/scripted-claude-`);
const dim: Dim = (args) => {
  const ran = Bun.spawnSync(["dim", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: ran.exitCode ?? 1, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
};

function tool(name: string, input: Record<string, unknown>, run: () => string): void {
  const id = `toolu_${crypto.randomUUID()}`;
  record({ type: "tool_use", id, name, input });
  emit({
    type: "assistant",
    session_id: sessionId,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const output = run();
  record({ type: "tool_result", id, output });
  emit({
    type: "user",
    session_id: sessionId,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
  });
  fire("PostToolUse", { tool_name: name, tool_input: input, tool_response: output }, name);
}

function ownOrder(): string {
  const shown = JSON.parse(dim(["order", "show"]).stdout) as { result?: { id?: string } };
  if (!shown.result?.id) throw new Error("dim order show names no order for this worker");
  return shown.result.id;
}

function bash(command: string): string {
  const ran = Bun.spawnSync(["sh", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return `${ran.stdout.toString()}${ran.stderr.toString()}exit ${ran.exitCode}`;
}

async function perform(act: HarnessAct): Promise<string | undefined> {
  switch (act.act) {
    case "sh":
      tool("Bash", { command: act.command }, () => bash(act.command));
      return;
    case "write": {
      const path = act.path.includes("{order}") ? act.path.replace("{order}", ownOrder()) : act.path;
      tool("Write", { file_path: path, content: act.content }, () => {
        writeFileSync(path, act.content);
        return `wrote ${path}`;
      });
      return;
    }
    case "say":
      record({ type: "assistant", text: act.text });
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { content: [{ type: "text", text: act.text }] },
      });
      return act.text;
    case "signal":
      mkdirSync(dirname(signalPath(state, act.name)), { recursive: true });
      writeFileSync(signalPath(state, act.name), String(process.pid));
      return;
    case "wait":
      while (!existsSync(releasePath(state, act.name))) await Bun.sleep(20);
      return;
    case "die":
      process.kill(process.pid, "SIGKILL");
      await Bun.sleep(60_000);
      return;
    case "limit":
      emit({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: Date.parse(act.resetsAt) / 1000 },
      });
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "usage limit reached",
        session_id: sessionId,
      });
      process.exit(1);
      return;
    default: {
      const args = dimArgs(act, dim, scratch);
      const command = ["dim", ...args].map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
      tool("Bash", { command }, () => bash(command));
      return;
    }
  }
}

let said = "";
for (const act of acts) said = (await perform(act)) ?? said;

emit({ type: "result", subtype: "success", is_error: false, result: said, session_id: sessionId });
fire("SessionEnd", { reason: "other" });

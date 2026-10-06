#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaudeHooks, fireHooksSync, mergeHooks, settingsHooks } from "./claude-hooks";
import {
  bashAllowed,
  type ClaudeSettings,
  type PermissionMode,
  sandboxed,
  writeAllowed,
} from "./claude-sandbox";
import { claudeLine, readTranscript, type TranscriptEntry, transcriptPath } from "./claude-transcript";
import { commandLine, parseDim, resultOf } from "./dim-output";
import { type HarnessAct, ORDER_PLACEHOLDER, TMPDIR_PLACEHOLDER } from "./harness-script";
import { OrderView } from "./order-view";
import {
  type Invocation,
  recordInvocation,
  releasePath,
  rememberRole,
  roleOf,
  signalPath,
  takeTurn,
} from "./scripted-harness-state";
import { sliceActs } from "./scripts";
import { unreachable } from "./unreachable";
import { roleOfInstructions } from "./vocabulary";
import { waitFor } from "./wait";
import { type Dim, isWorkerAct, workerCommand } from "./worker-acts";

type Flags = {
  readonly resume: string | null;
  readonly fork: boolean;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly instructions: string | null;
  readonly permissionMode: PermissionMode;
  readonly settings: ClaudeSettings & { readonly hooks?: ClaudeHooks };
  readonly settingSources: string | null;
  readonly prompt: string;
};

const NO_FLAGS: Flags = {
  resume: null,
  fork: false,
  sessionId: null,
  model: null,
  instructions: null,
  permissionMode: "default",
  settings: {},
  settingSources: null,
  prompt: "",
};

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function permissionMode(value: string): PermissionMode {
  const mode = PERMISSION_MODES.find((known) => known === value);
  if (mode === undefined) refuse(`error: option '--permission-mode' argument '${value}' is invalid`);
  return mode;
}

type Switch = "-p" | "--verbose" | "--fork-session";

const SWITCHES: Readonly<Record<Switch, (flags: Flags) => Flags>> = {
  "-p": (flags) => flags,
  "--verbose": (flags) => flags,
  "--fork-session": (flags) => ({ ...flags, fork: true }),
};

type Valued =
  | "--output-format"
  | "--permission-mode"
  | "--setting-sources"
  | "--settings"
  | "--model"
  | "--resume"
  | "--session-id"
  | "--append-system-prompt";

const VALUED: Readonly<Record<Valued, (flags: Flags, value: string) => Flags>> = {
  "--output-format": (flags) => flags,
  "--permission-mode": (flags, value) => ({ ...flags, permissionMode: permissionMode(value) }),
  "--setting-sources": (flags, value) => ({ ...flags, settingSources: value }),
  "--settings": (flags, value) => ({ ...flags, settings: JSON.parse(value) }),
  "--model": (flags, value) => ({ ...flags, model: value }),
  "--resume": (flags, value) => ({ ...flags, resume: value }),
  "--session-id": (flags, value) => ({ ...flags, sessionId: value }),
  "--append-system-prompt": (flags, value) => ({ ...flags, instructions: value }),
};

const isSwitch = (arg: string): arg is Switch => Object.hasOwn(SWITCHES, arg);

const isValued = (arg: string): arg is Valued => Object.hasOwn(VALUED, arg);

function parseFlags(argv: readonly string[]): Flags {
  let flags = NO_FLAGS;
  const positional: string[] = [];
  let pending: Valued | null = null;
  for (const [index, arg] of argv.entries()) {
    if (pending !== null) {
      flags = VALUED[pending](flags, arg);
      pending = null;
    } else if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    } else if (isSwitch(arg)) {
      flags = SWITCHES[arg](flags);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else if (isValued(arg)) {
      pending = arg;
    } else {
      refuse(`error: unknown option '${arg}'`);
    }
  }
  if (pending !== null) refuse(`error: option '${pending}' argument missing`);
  return { ...flags, prompt: positional.join(" ") };
}

const STDIN_WAIT_MS = 3000;

async function promptOnStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const first = await Promise.race([reader.read(), Bun.sleep(STDIN_WAIT_MS).then(() => null)]);
  if (first === null || first.done) {
    refuse(
      "Warning: no stdin data received in 3s, proceeding without it.\nError: Input must be provided either through stdin or as a prompt argument when using --print",
    );
  }
  const chunks = [first.value];
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  return Buffer.concat(chunks).toString("utf8");
}

const emit = (event: Readonly<Record<string, unknown>>) => process.stdout.write(`${JSON.stringify(event)}\n`);

const [stateArg, ...argv] = Bun.argv.slice(2);
if (stateArg === undefined) refuse("scripted claude: no state directory");
const state: string = stateArg;
const home = process.env.HOME;
if (home === undefined) refuse("scripted claude: HOME is not set");
const parsed = parseFlags(argv);
const flags =
  parsed.prompt || process.stdin.isTTY ? parsed : { ...parsed, prompt: (await promptOnStdin()).trim() };
const cwd = process.cwd();
const env: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
);

if (flags.resume !== null && !existsSync(transcriptPath(home, cwd, flags.resume))) {
  refuse(`No conversation found with session ID: ${flags.resume}`);
}

const sessionId =
  flags.resume !== null && !flags.fork ? flags.resume : (flags.sessionId ?? crypto.randomUUID());
const transcript = transcriptPath(home, cwd, sessionId);
mkdirSync(dirname(transcript), { recursive: true });
if (flags.resume !== null && flags.fork) copyFileSync(transcriptPath(home, cwd, flags.resume), transcript);
const history = readTranscript(transcript);

const role =
  flags.resume === null ? roleOfInstructions(flags.instructions ?? "") : roleOf(state, flags.resume);
if (role === null) {
  refuse(
    flags.resume === null
      ? "scripted claude: the system prompt holds no station's instructions"
      : `scripted claude: session ${flags.resume} was never started by this harness`,
  );
}
rememberRole(state, sessionId, role);

const sources = flags.settingSources === null ? ["user", "project"] : flags.settingSources.split(",");
const hooks = mergeHooks(
  sources.includes("user") ? settingsHooks(home) : {},
  sources.includes("project") ? settingsHooks(cwd) : {},
  flags.settings.hooks ?? {},
);
const fire = (event: string, payload: Readonly<Record<string, unknown>> = {}, tool?: string) =>
  fireHooksSync(
    hooks,
    event,
    { session_id: sessionId, transcript_path: transcript, ...payload },
    env,
    cwd,
    tool,
  );

const { turn, acts } = takeTurn(state, role);
const invocation: Invocation = {
  role,
  turn,
  sessionId,
  resumed: flags.resume,
  forked: flags.fork,
  model: flags.model,
  instructions: flags.instructions,
  prompt: flags.prompt,
  allowed: flags.settings.permissions?.allow ?? [],
  cwd,
  home,
  pid: process.pid,
  env,
  history,
};
recordInvocation(state, invocation);

const record = (entry: TranscriptEntry) =>
  appendFileSync(transcript, `${JSON.stringify(claudeLine(sessionId, cwd, entry))}\n`);

emit({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", model: flags.model });
fire("SessionStart", { source: flags.resume === null ? "startup" : "resume" });
record({ type: "user", text: flags.prompt });

const tmp = env.TMPDIR ?? tmpdir();
const scratch = mkdtempSync(`${tmp}/scripted-claude-`);
const sessionTmp = join(env.CLAUDE_CODE_TMPDIR ?? "/tmp", `claude-${process.getuid?.()}`);
mkdirSync(sessionTmp, { recursive: true });
const shell = (command: string) =>
  Bun.spawnSync(sandboxed(flags.settings, cwd, [sessionTmp], command), {
    cwd,
    env: { ...env, TMPDIR: sessionTmp },
    stdout: "pipe",
    stderr: "pipe",
  });
const dim: Dim = (args, schema) => {
  const ran = shell(commandLine(args));
  if (ran.signalCode) refuse(`scripted claude: \`dim ${args.join(" ")}\` was killed by ${ran.signalCode}`);
  return parseDim(
    { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() },
    schema,
  );
};

const shownOrder = () => resultOf(dim(["order", "show"], OrderView));

const withOrder = (text: string) => text.replaceAll(ORDER_PLACEHOLDER, () => shownOrder().id);

function tool(name: string, input: Readonly<Record<string, unknown>>, run: () => string): void {
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

function bash(command: string): string {
  if (!bashAllowed(flags.settings, flags.permissionMode)) return "Permission to use Bash has been denied.";
  const ran = shell(command);
  const ended = ran.signalCode ? `killed by ${ran.signalCode}` : `exit ${ran.exitCode}`;
  return `${ran.stdout.toString()}${ran.stderr.toString()}${ended}`;
}

async function perform(act: HarnessAct): Promise<string | null> {
  if (isWorkerAct(act)) {
    const command = withOrder(workerCommand(act, dim, scratch));
    tool("Bash", { command }, () => bash(command));
    return null;
  }
  switch (act.act) {
    case "sh": {
      const command = withOrder(act.command);
      tool("Bash", { command }, () => bash(command));
      return null;
    }
    case "write": {
      const path = resolve(cwd, withOrder(act.path).replaceAll(TMPDIR_PLACEHOLDER, sessionTmp));
      tool("Write", { file_path: path, content: act.content }, () => {
        if (!writeAllowed(flags.settings, flags.permissionMode, cwd, path))
          return `Permission to write ${path} has been denied.`;
        writeFileSync(path, act.content);
        return `wrote ${path}`;
      });
      return null;
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
      return null;
    case "wait":
      await waitFor(`the release of ${act.name}`, () => existsSync(releasePath(state, act.name)));
      return null;
    case "build-remaining": {
      await perform({ act: "sh", command: "git reset -q --hard && git clean -fdq" });
      for (const [index, slice] of shownOrder().slices.entries()) {
        if (slice.commit !== null) continue;
        for (const step of sliceActs(index + 1)) await perform(step);
      }
      return perform({ act: "build-return", artifact: act.artifact });
    }
    case "subagent": {
      const path = join(dirname(transcript), sessionId, "subagents", `agent-${act.agent}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      const id = `toolu_${crypto.randomUUID()}`;
      const entries: TranscriptEntry[] = [
        { type: "tool_use", id, name: "Bash", input: { command: act.command } },
        { type: "tool_result", id, output: "exit 0" },
      ];
      for (const entry of entries)
        appendFileSync(path, `${JSON.stringify(claudeLine(sessionId, cwd, entry))}\n`);
      writeFileSync(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore" }));
      return null;
    }
    case "die":
      process.kill(process.pid, "SIGKILL");
      return null;
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
      return process.exit(1);
    default:
      return unreachable(act);
  }
}

let said = "";
for (const act of acts) said = (await perform(act)) ?? said;

emit({ type: "result", subtype: "success", is_error: false, result: said, session_id: sessionId });
fire("SessionEnd", { reason: "other" });

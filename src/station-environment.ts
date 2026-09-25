import { WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import type { ProcessEnvironment } from "./harness-process";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR } from "./worker-assignment";

/**
 * The process spawning a worker is the operator's. A worker's factory identity is whatever
 * its request carries and nothing else, or a first turn — whose request carries only an
 * assignment — would inherit the operator's token and could act as the operator.
 */
const FACTORY_IDENTITY_VARS = [
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
  WORKER_SESSION_VAR,
  ASSIGNMENT_ID_VAR,
  ASSIGNMENT_TOKEN_VAR,
];

/**
 * An operator run from inside Claude Code exports its own session to every child, whatever
 * harness the child runs: its id, its messaging socket and token, and whether a person is
 * attending it. A worker holding those could post into the operator's unsandboxed session and
 * have its hooks filed under it. An operator run from inside Codex exports its thread id, which
 * `dim operator` reads to pick a session, so a worker holding it would resolve as the operator.
 * `CLAUDE_CODE_OAUTH_TOKEN` is a subscription login, as `claude setup-token` issues it on a
 * machine without a keychain, so it is kept.
 */
const OPERATOR_SESSION_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CODEX_THREAD_ID"];
const SUBSCRIPTION_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function operatorSessionVar(name: string): boolean {
  if (name === SUBSCRIPTION_TOKEN_VAR) return false;
  return name.startsWith("CLAUDE_CODE_") || OPERATOR_SESSION_VARS.includes(name);
}

/** What a process the operator starts for a station inherits: the operator's environment, less
 *  its factory identity and its harness session, plus what the station hands it. */
export function stationEnvironment(given: ProcessEnvironment = {}): ProcessEnvironment {
  const inherited: ProcessEnvironment = { ...globalThis.process.env };
  for (const name of FACTORY_IDENTITY_VARS) delete inherited[name];
  Object.assign(inherited, given);
  for (const name of Object.keys(inherited)) if (operatorSessionVar(name)) delete inherited[name];
  return inherited;
}

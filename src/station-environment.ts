import type { ProcessEnvironment } from "./harness-process";
import { WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR } from "./worker-assignment";

const FACTORY_IDENTITY_VARS = [
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
  WORKER_SESSION_VAR,
  ASSIGNMENT_ID_VAR,
  ASSIGNMENT_TOKEN_VAR,
];

const OPERATOR_SESSION_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CODEX_THREAD_ID"];
const SUBSCRIPTION_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function operatorSessionVar(name: string): boolean {
  if (name === SUBSCRIPTION_TOKEN_VAR) return false;
  return name.startsWith("CLAUDE_CODE_") || OPERATOR_SESSION_VARS.includes(name);
}

export function stationEnvironment(given: ProcessEnvironment = {}): ProcessEnvironment {
  const inherited: ProcessEnvironment = { ...globalThis.process.env };
  for (const name of FACTORY_IDENTITY_VARS) delete inherited[name];
  Object.assign(inherited, given);
  for (const name of Object.keys(inherited)) if (operatorSessionVar(name)) delete inherited[name];
  return inherited;
}

import type { ProcessEnvironment } from "./harness-process";
import { WORKER_NAME_VAR } from "./worker";

const PROCESS_VARS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

const DIM_LOCATION_VARS = ["DIM_HOME", "XDG_DATA_HOME", "DIM_CLAUDE_PROJECTS", "DIM_CODEX_DIR", "GROK_HOME"];

export const NETWORK_VARS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

function allowed(names: readonly string[], source: ProcessEnvironment): ProcessEnvironment {
  return Object.fromEntries(
    names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
}

export function checkEnvironment(given: ProcessEnvironment = {}): ProcessEnvironment {
  return allowed(PROCESS_VARS, { ...globalThis.process.env, ...given });
}

export function workerEnvironment(
  harnessVars: readonly string[],
  given: ProcessEnvironment = {},
): ProcessEnvironment {
  const owner: ProcessEnvironment = { ...globalThis.process.env, [WORKER_NAME_VAR]: undefined };
  return allowed([...PROCESS_VARS, ...DIM_LOCATION_VARS, WORKER_NAME_VAR, ...harnessVars], {
    ...owner,
    ...given,
  });
}

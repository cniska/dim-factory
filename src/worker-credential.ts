import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MintedWorker } from "./factory-worker";
import { dataDir, type Env } from "./paths";

function credentialPath(env: Env, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(dataDir(env), "worker-credentials", `${key}.json`);
}

export function saveWorkerCredential(env: Env, worker: MintedWorker): void {
  const path = credentialPath(env, worker.sessionId);
  mkdirSync(join(dataDir(env), "worker-credentials"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(worker), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readWorkerCredential(env: Env, sessionId: string): MintedWorker | null {
  const path = credentialPath(env, sessionId);
  try {
    const worker = JSON.parse(readFileSync(path, "utf8")) as MintedWorker;
    if (worker.sessionId !== sessionId || !worker.name || !worker.token) return null;
    return worker;
  } catch {
    return null;
  }
}

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir, type Env, resolveHomeDir } from "./paths";

export const AGENT_LABEL = "dev.dimfactory.sync";
const INTERVAL_SECONDS = 900;

export function agentPlistPath(env: Env = process.env): string {
  return join(resolveHomeDir(env), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

export function syncLogPath(env: Env = process.env): string {
  return join(dataDir(env), "sync.log");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function agentPlist(bunPath: string, repoDir: string, env: Env = process.env): string {
  const args = [bunPath, "run", join(repoDir, "src", "cli.ts"), "sync"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlText(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlText(repoDir)}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlText(syncLogPath(env))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(syncLogPath(env))}</string>
</dict>
</plist>
`;
}

export type AgentPlan = { path: string; contents: string; unchanged: boolean };

export function bunPath(): string {
  return Bun.which("bun") ?? process.execPath;
}

export function planAgent(env: Env = process.env): AgentPlan {
  const path = agentPlistPath(env);
  const contents = agentPlist(bunPath(), resolve(import.meta.dir, ".."), env);
  const unchanged = existsSync(path) && readFileSync(path, "utf8") === contents;
  return { path, contents, unchanged };
}

export function installAgent(env: Env = process.env): AgentPlan {
  const plan = planAgent(env);
  if (plan.unchanged) return plan;
  mkdirSync(dirname(plan.path), { recursive: true });
  if (existsSync(plan.path)) copyFileSync(plan.path, `${plan.path}.dim-backup`);
  writeFileSync(plan.path, plan.contents);
  return plan;
}

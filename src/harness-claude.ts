import { join, resolve } from "node:path";
import type { Adapter, Policy, SessionStart, Start } from "./harness-contract";

const DIM_PLUGIN = resolve(import.meta.dir, "..");

const NOT_ALPHANUMERIC = /[^A-Za-z0-9]/g;

const absoluteRule = (path: string) => `/${path}`;

function sessionFlags(session: SessionStart): readonly string[] {
  switch (session.kind) {
    case "new":
      return ["--session-id", session.id];
    case "resume":
      return ["--resume", session.id];
  }
}

const EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

function deniedTools(policy: Policy): readonly string[] {
  switch (policy.kind) {
    case "read":
      return EDIT_TOOLS;
    case "edit":
      return policy.denied.map((path) => `Edit(${absoluteRule(path)}/**)`);
  }
}

const PERMISSION_MODE: Readonly<Record<Policy["kind"], string>> = { read: "default", edit: "acceptEdits" };

function settings({ policy, socket }: Start): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: policy.writable, denyWrite: policy.denied },
      network: { allowUnixSockets: [socket] },
    },
    permissions: { deny: deniedTools(policy) },
  });
}

export const claude: Adapter = {
  signIn: ["CLAUDE_CODE_OAUTH_TOKEN"],
  argv: (start) => [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    start.model,
    "--permission-mode",
    PERMISSION_MODE[start.policy.kind],
    "--settings",
    settings(start),
    "--setting-sources",
    "user",
    "--plugin-dir",
    DIM_PLUGIN,
    ...sessionFlags(start.session),
  ],
  transcript: (home, workspace, session) =>
    join(home, ".claude", "projects", workspace.replace(NOT_ALPHANUMERIC, "-"), `${session}.jsonl`),
};

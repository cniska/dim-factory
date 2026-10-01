import { join, resolve } from "node:path";
import { z } from "zod";
import type { Adapter, Ended, Outcome, Policy, SessionStart, Start } from "./harness-contract";

const DIM_PLUGIN = resolve(import.meta.dir, "..");

const NOT_ALPHANUMERIC = /[^A-Za-z0-9]/g;

const absoluteRule = (path: string) => `/${path}`;

function sessionFlags(session: SessionStart): readonly string[] {
  switch (session.kind) {
    case "new":
      return ["--session-id", session.id];
    case "resume":
      return ["--resume", session.id];
    case "fork":
      return ["--resume", session.from, "--fork-session", "--session-id", session.id];
  }
}

const StreamEvent = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  rate_limit_info: z.object({ status: z.string(), resetsAt: z.number().optional() }).optional(),
});

const MS_PER_SECOND = 1000;

function outcome({ lines }: Ended, session: SessionStart): Outcome {
  const events = lines.map((line) => StreamEvent.parse(JSON.parse(line)));
  const limit = events.find((event) => event.rate_limit_info?.status === "rejected")?.rate_limit_info;
  if (limit !== undefined) {
    const resetsAt =
      limit.resetsAt === undefined ? null : new Date(limit.resetsAt * MS_PER_SECOND).toISOString();
    return { kind: "died", code: "usage_limit", resetsAt };
  }
  if (events.some((event) => event.type === "result")) return { kind: "finished" };
  const started = events.some((event) => event.type === "system" && event.subtype === "init");
  return { kind: "died", code: session.kind !== "new" && !started ? "resume_failed" : "killed" };
}

const EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

const editRule = (path: string) => `Edit(${absoluteRule(path)}/**)`;

function permissions(policy: Policy): {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
} {
  switch (policy.kind) {
    case "read":
      return { allow: [], deny: EDIT_TOOLS };
    case "edit":
      return { allow: policy.writable.map(editRule), deny: policy.denied.map(editRule) };
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
    permissions: permissions(policy),
  });
}

export const claude: Adapter = {
  signIn: ["CLAUDE_CODE_OAUTH_TOKEN"],
  tempRoot: "CLAUDE_CODE_TMPDIR",
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
  outcome,
};

import { join } from "node:path";
import { z } from "zod";
import type { Adapter, Ended, Outcome, Policy, SessionStart, Start } from "./harness-contract";

const NOT_ALPHANUMERIC = /[^A-Za-z0-9]/g;

const projectDir = (home: string, workspace: string) =>
  join(home, ".claude", "projects", workspace.replace(NOT_ALPHANUMERIC, "-"));

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
  result: z.string().optional(),
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
  const result = events.filter((event) => event.type === "result").at(-1);
  if (result !== undefined) return { kind: "finished", result: result.result ?? null };
  const started = events.some((event) => event.type === "system" && event.subtype === "init");
  return { kind: "died", code: session.kind !== "new" && !started ? "resume_failed" : "killed" };
}

const editRule = (path: string) => `Edit(${absoluteRule(path)}/**)`;

const permissions = ({ writable, denied }: Policy) => ({
  allow: writable.map(editRule),
  deny: denied.map(editRule),
});

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
  name: "claude",
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
    "--append-system-prompt",
    start.instructions,
    ...sessionFlags(start.session),
  ],
  transcript: (home, workspace, session) => join(projectDir(home, workspace), `${session}.jsonl`),
  subagents: (home, workspace, session) => join(projectDir(home, workspace), session, "subagents"),
  outcome,
};

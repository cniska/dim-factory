import { join, resolve } from "node:path";
import { z } from "zod";
import type { Adapter, Outcome, SessionStart, Start } from "./harness-contract";

const DIM_PLUGIN = resolve(import.meta.dir, "..");

const Result = z.object({ type: z.literal("result"), subtype: z.string(), result: z.string().optional() });

const RateLimit = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({ status: z.string(), resetsAt: z.number().optional() }),
});

function sessionFlags(session: SessionStart): readonly string[] {
  switch (session.kind) {
    case "new":
      return ["--session-id", session.id];
    case "resume":
      return ["--resume", session.id];
  }
}

function settings(start: Start): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [start.tmp], denyWrite: [start.workspace] },
      network: { allowUnixSockets: [start.socket] },
    },
    permissions: { deny: ["Write", "Edit", "NotebookEdit"] },
  });
}

function lineOutcome(line: string): Outcome | null {
  const parsed: unknown = JSON.parse(line);
  const limit = RateLimit.safeParse(parsed);
  if (limit.success && limit.data.rate_limit_info.status === "rejected") {
    const { resetsAt } = limit.data.rate_limit_info;
    return {
      kind: "limited",
      resetsAt: resetsAt === undefined ? null : new Date(resetsAt * 1000).toISOString(),
    };
  }
  const result = Result.safeParse(parsed);
  if (result.success && result.data.subtype === "success") {
    return { kind: "finished", text: result.data.result ?? "" };
  }
  return null;
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
    "default",
    "--settings",
    settings(start),
    "--setting-sources",
    "user",
    "--plugin-dir",
    DIM_PLUGIN,
    ...sessionFlags(start.session),
  ],
  outcome(lines) {
    const outcomes = lines.flatMap((line) => lineOutcome(line) ?? []);
    return (
      outcomes.find((outcome) => outcome.kind === "limited") ?? outcomes.at(-1) ?? { kind: "unfinished" }
    );
  },
  transcript: (home, workspace, session) =>
    join(home, ".claude", "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`),
};

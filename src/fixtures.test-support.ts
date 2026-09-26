import type { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installHooks } from "./hooks";
import { startAttempt } from "./order-attempt";
import type { OrderCheck } from "./order-evidence";
import { appendOrderEventInTransaction } from "./order-ledger";
import type { Env } from "./paths";
import { REVIEW_DIMENSIONS, type ReviewFinding } from "./station-review-artifact";
import { mintWorker, newWorkerSession, WORKER_NAME_VAR, WORKER_TOKEN_VAR } from "./worker";
import type { Role } from "./worker-roles";
import { worktreePath } from "./wt-command";

export function attemptIn(
  db: Database,
  orderId: string,
  worker: string,
  operatorWorker: string,
  runId = "run-1",
  at = new Date().toISOString(),
): void {
  startAttempt(db, orderId, { runId, worker, operatorWorker, station: "build" }, at);
}

export function workerIn(db: Database, role: Role = "builder"): string {
  return mintWorker(db, { role, sessionId: newWorkerSession("test-worker") }).name;
}

export function openReviewBy(
  db: Database,
  orderId: string,
  round: { reviewer: string; baseSha: string; headSha: string },
  worker: string,
  at = new Date().toISOString(),
): { id: number; reviewer: string } {
  return db.transaction(() => {
    const next =
      (db
        .query<{ n: number }, [string]>(
          "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
        )
        .get(orderId)?.n as number) + 1;
    const written = db.run(
      `INSERT INTO factory_order_review (order_id, round, reviewer, base_sha, head_sha, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, next, round.reviewer, round.baseSha, round.headSha, at],
    );
    const id = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "review_opened", worker, reviewId: id }, at);
    return { id, reviewer: round.reviewer };
  })();
}

export function reviewIn(
  db: Database,
  orderId: string,
  by: string,
  at?: string,
  sha = "base0000",
): { review: number; reviewer: string } {
  const reviewer = mintWorker(db, { role: "reviewer", sessionId: newWorkerSession("test-reviewer") }).name;
  const opened = openReviewBy(db, orderId, { reviewer, baseSha: sha, headSha: sha }, by, at);
  return { review: opened.id, reviewer };
}

export function located(finding: Pick<ReviewFinding, "dimension" | "failure">): ReviewFinding {
  return { file: "src/example.ts", line: 1, fix: "make it hold", severity: "medium", ...finding };
}

export function ranCheck(
  check: Pick<OrderCheck, "command" | "exitCode"> & Partial<OrderCheck>,
  at = new Date().toISOString(),
): OrderCheck {
  return { startedAt: at, finishedAt: at, result: "", ...check };
}

export function reviewOutput(fields: Record<string, unknown> = {}): string {
  const findings = (fields.findings ?? []) as { dimension: string }[];
  const flagged = new Set(findings.map((finding) => finding.dimension));
  return JSON.stringify({
    verdict: "The change does what the plan asked.",
    findings,
    conformance: [],
    coverage: REVIEW_DIMENSIONS.map((dimension) => ({
      dimension,
      status: flagged.has(dimension) ? "findings" : "clean",
      reason: null,
    })),
    set_aside: [],
    unverified: [],
    observations: [],
    ...fields,
  });
}

export function workerEnv(db: Database, role: Role = "builder"): Env {
  const minted = mintWorker(db, { role, sessionId: newWorkerSession("test-worker") });
  return { [WORKER_NAME_VAR]: minted.name, [WORKER_TOKEN_VAR]: minted.token };
}

let signingKey: { key: string; allowedSigners: string } | undefined;

export function signCommitsIn(dir: string): void {
  if (!signingKey) {
    const keys = mkdtempSync(join(tmpdir(), "dim-signing-"));
    const key = join(keys, "id_ed25519");
    Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "t@example.com", "-f", key]);
    const allowedSigners = join(keys, "allowed_signers");
    writeFileSync(allowedSigners, `t@example.com ${readFileSync(`${key}.pub`, "utf8")}`);
    signingKey = { key, allowedSigners };
  }
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  git(["config", "gpg.format", "ssh"]);
  git(["config", "user.signingkey", signingKey.key]);
  git(["config", "gpg.ssh.allowedSignersFile", signingKey.allowedSigners]);
  git(["config", "commit.gpgsign", "true"]);
}

export function integratedRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-trunk-"));
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  signCommitsIn(dir);
  git(["config", "dim.ship", "trunk"]);
  writeFileSync(join(dir, "landed.txt"), "landed");
  writeFileSync(join(dir, ".gitignore"), ".claude/\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feat: land it"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return { dir, sha: git(["rev-parse", "HEAD"]).stdout.toString().trim() };
}

export function declareCheck(dir: string, script = "true"): string {
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { verify: script } }));
  writeFileSync(join(dir, "bun.lock"), "");
  git(["add", "package.json", "bun.lock"]);
  git(["commit", "-q", "-m", "chore: declare the check"]);
  return git(["rev-parse", "HEAD"]).stdout.toString().trim();
}

let checkSandboxScript: string | undefined;

export function confiningCheckSandbox(): string[] {
  if (!checkSandboxScript) {
    checkSandboxScript = join(mkdtempSync(join(tmpdir(), "dim-check-sandbox-")), "sandbox");
    writeFileSync(checkSandboxScript, '#!/bin/sh\ncase "$*" in *check-canary-*) exit 1 ;; esac\nexec "$@"\n');
    chmodSync(checkSandboxScript, 0o755);
  }
  return [checkSandboxScript];
}

export function commitOffTrunk(dir: string, branch: string): string {
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" });
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(dir, `${branch}.txt`), branch);
  git(["add", "."]);
  git(["commit", "-q", "-m", `feat: ${branch}`]);
  const sha = git(["rev-parse", "HEAD"]).stdout.toString().trim();
  git(["checkout", "-q", "main"]);
  return sha;
}

export function orderWorktree(dir: string, branch: string): string {
  const path = worktreePath(dir, branch);
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  appendFileSync(join(dir, ".git", "info", "exclude"), "/.claude/\n");
  git(["worktree", "add", "-q", "-b", branch, path]);
  return path;
}

export function repoWithoutTrunk(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-no-trunk-"));
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "landed.txt"), "landed");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feat: land it"]);
  return { dir, sha: git(["rev-parse", "HEAD"]).stdout.toString().trim() };
}

export function collectingMachine(): { dir: string; env: Env } {
  const dir = mkdtempSync(join(tmpdir(), "dim-hooks-"));
  const env = scratchEnv(dir);
  installHooks(env);
  return { dir, env };
}

export function scratchEnv(root: string): Env {
  return {
    DIM_HOME: join(root, "home"),
    DIM_CLAUDE_PROJECTS: join(root, "claude-projects"),
    DIM_CODEX_DIR: join(root, "codex"),
  };
}

function writeLines(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, body);
  return body;
}

export function writePrefix(path: string, lines: unknown[], bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, Buffer.from(body, "utf8").subarray(0, bytes));
}

export function bytesThroughLine(lines: unknown[], index: number): number {
  return Buffer.byteLength(
    `${lines
      .slice(0, index + 1)
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
    "utf8",
  );
}

export function fullBytes(lines: unknown[]): number {
  return Buffer.byteLength(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

const TS = (n: number) => `2026-09-16T10:${String(n).padStart(2, "0")}:00.000Z`;

export function claudeTranscriptLines(sessionId: string): unknown[] {
  const base = {
    sessionId,
    cwd: "/Users/x/code/demo",
    gitBranch: "main",
    version: "2.1.260",
    entrypoint: "cli",
    isSidechain: false,
    userType: "external",
  };
  return [
    { type: "mode", sessionId, mode: "auto" },
    {
      ...base,
      type: "user",
      uuid: "u-1",
      timestamp: TS(1),
      promptSource: "typed",
      promptId: "p-1",
      origin: { kind: "human" },
      message: { role: "user", content: "add the parser" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a-1a",
      timestamp: TS(2),
      requestId: "req-1",
      attributionSkill: "build",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        stop_reason: null,
        content: [
          { type: "thinking", thinking: "SECRET REASONING" },
          { type: "text", text: "First half." },
        ],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
          output_tokens: 9,
          output_tokens_details: { thinking_tokens: 4 },
          service_tier: "standard",
        },
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a-1b",
      timestamp: TS(3),
      requestId: "req-1",
      attributionSkill: "build",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Second half." },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
        ],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 30 },
          service_tier: "standard",
        },
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-2",
      timestamp: TS(4),
      toolUseResult: { stdout: "SECRET FILE CONTENTS", stderr: "" },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "SECRET FILE CONTENTS" }],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-3",
      timestamp: TS(5),
      isMeta: true,
      sourceToolUseID: "toolu-2",
      message: {
        role: "user",
        content: "Base directory for this skill: /Users/x/.claude/skills/build\n\n# Build",
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-4",
      timestamp: TS(6),
      interruptedMessageId: "msg-1",
      toolDenialKind: "user-rejected",
      userFeedback: "no, not like that",
      message: { role: "user", content: [{ type: "text", text: "stop" }] },
    },
    { type: "ai-title", sessionId, aiTitle: "Add the parser" },
    {
      ...base,
      type: "system",
      subtype: "turn_duration",
      uuid: "turn-1",
      timestamp: TS(7),
      durationMs: 7193,
      messageCount: 13,
    },
    {
      ...base,
      type: "cost-state",
      uuid: "cost-1",
      timestamp: TS(8),
      totalCostUSD: 9.611748,
      modelUsage: { "claude-opus-5[1m]": { inputTokens: 5, outputTokens: 50, costUSD: 9.611748 } },
      totalAPIDuration: 516997,
      totalLinesAdded: 45,
      totalLinesRemoved: 10,
      hasUnknownModelCost: false,
    },
  ];
}

export function writeClaudeTranscript(env: Env, slug: string, sessionId: string): string {
  const path = join(env.DIM_CLAUDE_PROJECTS as string, slug, `${sessionId}.jsonl`);
  writeLines(path, claudeTranscriptLines(sessionId));
  return path;
}

export function codexRolloutLines(threadId: string, opts: { withIds: boolean }): unknown[] {
  const id = (n: number) => (opts.withIds ? `msg-${threadId}-${n}` : null);
  return [
    {
      type: "session_meta",
      timestamp: TS(1),
      ordinal: 0,
      payload: {
        id: threadId,
        timestamp: TS(1),
        cwd: "/Users/x/code/demo",
        originator: "codex-tui",
        cli_version: "0.154.0",
        source: "cli",
        model_provider: "openai",
        history_mode: "paginated",
        git: { branch: "main" },
      },
    },
    {
      type: "turn_context",
      timestamp: TS(2),
      ordinal: 1,
      payload: { turn_id: "turn-1", model: "gpt-5.6-luna", cwd: "/Users/x/code/demo", effort: "medium" },
    },
    {
      type: "response_item",
      timestamp: TS(3),
      ordinal: 2,
      payload: {
        type: "message",
        id: id(2),
        role: "user",
        content: [{ type: "input_text", text: "add the parser" }],
      },
    },
    {
      type: "response_item",
      timestamp: TS(4),
      ordinal: 3,
      payload: {
        type: "message",
        id: id(3),
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "token_usage_record",
      timestamp: TS(5),
      ordinal: 4,
      payload: {
        thread_id: threadId,
        turn_id: "turn-1",
        response_id: `resp-${threadId}-1`,
        usage: {
          input_tokens: 18018,
          cached_input_tokens: 9984,
          cache_write_input_tokens: 0,
          output_tokens: 305,
          reasoning_output_tokens: 94,
          total_tokens: 18323,
        },
      },
    },
    {
      type: "turn_context",
      timestamp: TS(6),
      ordinal: 5,
      payload: { turn_id: "turn-2", model: "gpt-5.6-sol", cwd: "/Users/x/code/demo" },
    },
    {
      type: "response_item",
      timestamp: TS(7),
      ordinal: 6,
      payload: {
        type: "message",
        id: id(6),
        role: "assistant",
        content: [{ type: "output_text", text: "And more." }],
      },
    },
    {
      type: "event_msg",
      timestamp: TS(8),
      ordinal: 7,
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "SECRET AGENT MESSAGE",
        started_at: 1789496759,
        completed_at: 1789496911,
        duration_ms: 151652,
        time_to_first_token_ms: 4693,
      },
    },
    {
      type: "event_msg",
      timestamp: TS(9),
      ordinal: 8,
      payload: {
        type: "turn_aborted",
        turn_id: "turn-2",
        reason: "interrupted",
        started_at: 1789536555,
        completed_at: 1789536563,
        duration_ms: 8128,
      },
    },
  ];
}

export function writeCodexRollout(env: Env, dir: "sessions" | "archived_sessions", threadId: string): string {
  const name = `rollout-2026-09-16T10-00-00-${threadId}.jsonl`;
  const path =
    dir === "sessions"
      ? join(env.DIM_CODEX_DIR as string, "sessions", "2026", "09", "16", name)
      : join(env.DIM_CODEX_DIR as string, "archived_sessions", name);
  writeLines(path, codexRolloutLines(threadId, { withIds: true }));
  return path;
}

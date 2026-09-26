import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { gitSubcommands } from "./git-operations";
import { readChunk } from "./ingest-chunk";
import type { ParsedChunk, SessionFacts } from "./ingest-session-records";
import type { Tool } from "./ingest-tools";
import { worktreeOf } from "./worktree";
export type Kind = "transcript" | "subagent" | "rollout";

export type FileSpec = {
  path: string;
  tool: Tool;
  kind: Kind;
  sessionId: string;
  parentId?: string;
  agentType?: string;
  parse: (lines: string[], firstLineNumber: number, state: string | null) => ParsedChunk;
};

export type FileResult = {
  read: boolean;
  bytes: number;
  lines: number;
  reset: boolean;
  dropped: number[];
};

const MERGED_TEXT = `CASE
  WHEN excluded.text IS NULL THEN message.text
  WHEN message.text IS NULL THEN excluded.text
  ELSE message.text || char(10) || excluded.text END`;

type CursorRow = {
  path: string;
  bytes_ingested: number;
  lines_ingested: number;
  cursor_state: string | null;
};

function foldSession(facts: SessionFacts[]) {
  const out: {
    cwd?: string;
    project?: string;
    gitBranch?: string;
    cliVersion?: string;
    entrypoint?: string;
    startedAt?: string;
    lastSeenAt?: string;
    firstModel?: string;
    lastModel?: string;
    title?: string;
    extra?: string;
  } = {};
  for (const f of facts) {
    if (f.ts) {
      if (!out.startedAt || f.ts < out.startedAt) out.startedAt = f.ts;
      if (!out.lastSeenAt || f.ts > out.lastSeenAt) out.lastSeenAt = f.ts;
    }
    out.cwd ??= f.cwd;
    out.project ??= f.project;
    out.entrypoint ??= f.entrypoint;
    out.firstModel ??= f.model;
    out.extra ??= f.extra;
    if (f.gitBranch) out.gitBranch = f.gitBranch;
    if (f.cliVersion) out.cliVersion = f.cliVersion;
    if (f.model) out.lastModel = f.model;
    if (f.title) out.title = f.title;
  }
  return out;
}

export function createIngester(db: Database) {
  const selectCursor = db.prepare<CursorRow, [string, string]>(
    "SELECT path, bytes_ingested, lines_ingested, cursor_state FROM source_file WHERE session_id = ? AND kind = ?",
  );
  const movePath = db.prepare<void, [string, string, string]>(
    "UPDATE source_file SET path = ? WHERE session_id = ? AND kind = ?",
  );
  const insertSourceFile = db.prepare<void, [string, string, string, string, string]>(
    `INSERT INTO source_file (path, tool, kind, session_id, origin_mtime)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (id, tool, parent_id, agent_type, cwd, worktree, project, git_branch, cli_version,
       entrypoint, started_at, last_seen_at, first_model, last_model, title, extra)
     VALUES ($id, $tool, $parent, $agentType, $cwd, $worktree, $project, $gitBranch, $cliVersion,
       $entrypoint, $startedAt, $lastSeenAt, $firstModel, $lastModel, $title, $extra)
     ON CONFLICT(id) DO UPDATE SET
       parent_id    = coalesce(session.parent_id, excluded.parent_id),
       agent_type   = coalesce(session.agent_type, excluded.agent_type),
       cwd          = coalesce(session.cwd, excluded.cwd),
       worktree     = coalesce(session.worktree, excluded.worktree),
       project      = coalesce(session.project, excluded.project),
       git_branch   = coalesce(excluded.git_branch, session.git_branch),
       cli_version  = coalesce(excluded.cli_version, session.cli_version),
       entrypoint   = coalesce(session.entrypoint, excluded.entrypoint),
       started_at   = min(coalesce(session.started_at, excluded.started_at),
                          coalesce(excluded.started_at, session.started_at)),
       last_seen_at = max(coalesce(session.last_seen_at, excluded.last_seen_at),
                          coalesce(excluded.last_seen_at, session.last_seen_at)),
       first_model  = coalesce(session.first_model, excluded.first_model),
       last_model   = coalesce(excluded.last_model, session.last_model),
       title        = coalesce(excluded.title, session.title),
       extra        = coalesce(session.extra, excluded.extra)`,
  );

  const upsertMessage = db.prepare(
    `INSERT INTO message (id, session_id, ts, role, model, turn_id, prompt_source, origin_kind,
       is_meta, is_skill_body, attribution_skill, stop_reason, interrupted_message_id, denial_kind,
       user_feedback, text, text_chars, src_file, src_line, extra)
     VALUES ($id, $sessionId, $ts, $role, $model, $turnId, $promptSource, $originKind,
       $isMeta, $isSkillBody, $attributionSkill, $stopReason, $interruptedMessageId, $denialKind,
       $userFeedback, $text, $textChars, $srcFile, $srcLine, $extra)
     ON CONFLICT(id) DO UPDATE SET
       ts                     = min(message.ts, excluded.ts),
       model                  = coalesce(excluded.model, message.model),
       turn_id                = coalesce(excluded.turn_id, message.turn_id),
       prompt_source          = coalesce(excluded.prompt_source, message.prompt_source),
       origin_kind            = coalesce(excluded.origin_kind, message.origin_kind),
       is_meta                = max(message.is_meta, excluded.is_meta),
       is_skill_body          = max(message.is_skill_body, excluded.is_skill_body),
       attribution_skill      = coalesce(excluded.attribution_skill, message.attribution_skill),
       stop_reason            = coalesce(excluded.stop_reason, message.stop_reason),
       interrupted_message_id = coalesce(excluded.interrupted_message_id, message.interrupted_message_id),
       denial_kind            = coalesce(excluded.denial_kind, message.denial_kind),
       user_feedback          = coalesce(excluded.user_feedback, message.user_feedback),
       text                   = ${MERGED_TEXT},
       text_chars             = length(${MERGED_TEXT}),
       src_file               = excluded.src_file,
       src_line               = min(message.src_line, excluded.src_line),
       extra                  = coalesce(excluded.extra, message.extra)`,
  );

  const insertUsage = db.prepare(
    `INSERT INTO usage (response_id, session_id, message_id, ts, model, input_tokens,
       cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens,
       reasoning_tokens, attribution_skill, extra)
     VALUES ($responseId, $sessionId, $messageId, $ts, $model, $inputTokens,
       $cacheReadTokens, $cacheWriteTokens, $cacheWrite1hTokens, $outputTokens,
       $reasoningTokens, $attributionSkill, $extra)
     -- One API response is written as one line per content block, and usage
     -- accumulates across them: only the last line holds the complete figures.
     -- The whole row is replaced together so its fields stay from one line.
     -- Keyed on output_tokens rather than a terminal stop_reason: over one full
     -- corpus the two pick the same record for all but 0.5% of responses, and
     -- every one of those was interrupted and has no terminal record at all, so
     -- a stop_reason filter would drop them without saying so.
     ON CONFLICT(response_id) DO UPDATE SET
       message_id            = excluded.message_id,
       ts                    = excluded.ts,
       model                 = excluded.model,
       input_tokens          = excluded.input_tokens,
       cache_read_tokens     = excluded.cache_read_tokens,
       cache_write_tokens    = excluded.cache_write_tokens,
       cache_write_1h_tokens = excluded.cache_write_1h_tokens,
       output_tokens         = excluded.output_tokens,
       reasoning_tokens      = excluded.reasoning_tokens,
       attribution_skill     = excluded.attribution_skill,
       extra                 = excluded.extra
     WHERE excluded.output_tokens > usage.output_tokens`,
  );

  const upsertTurn = db.prepare(
    `INSERT INTO turn (session_id, turn_id, ts_start, ts_end, duration_ms, message_count,
       status, model, time_to_first_token_ms)
     VALUES ($sessionId, $turnId, $tsStart, $tsEnd, $durationMs, $messageCount,
       $status, $model, $timeToFirstTokenMs)
     ON CONFLICT(session_id, turn_id) DO UPDATE SET
       ts_start               = coalesce(excluded.ts_start, turn.ts_start),
       ts_end                 = max(turn.ts_end, excluded.ts_end),
       duration_ms            = coalesce(excluded.duration_ms, turn.duration_ms),
       message_count          = coalesce(excluded.message_count, turn.message_count),
       status                 = excluded.status,
       model                  = coalesce(excluded.model, turn.model),
       time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn.time_to_first_token_ms)`,
  );

  const upsertCost = db.prepare(
    `INSERT INTO session_cost_reported (session_id, reported_by, total_cost_usd, model_usage,
       has_unknown_model_cost, ts)
     VALUES ($sessionId, $reportedBy, $totalCostUsd, $modelUsage, $hasUnknownModelCost, $ts)
     ON CONFLICT(session_id) DO UPDATE SET
       reported_by            = excluded.reported_by,
       total_cost_usd         = excluded.total_cost_usd,
       model_usage            = excluded.model_usage,
       has_unknown_model_cost = excluded.has_unknown_model_cost,
       ts                     = excluded.ts`,
  );

  const upsertToolCall = db.prepare(
    `INSERT INTO tool_call (id, session_id, message_id, model, attribution_skill, ts_call, ts_result,
       tool_name, skill_name, file_path, command, is_error, interrupted, exit_code, duration_ms,
       git_operation, result_bytes, src_file, src_line_call, src_line_result, extra)
     VALUES ($id, $sessionId, $messageId, $model, $attributionSkill, $tsCall, $tsResult,
       $toolName, $skillName, $filePath, $command, $isError, $interrupted, $exitCode, $durationMs,
       $gitOperation, $resultBytes, $srcFile, $srcLineCall, $srcLineResult, $extra)
     -- The call and its result are separate records, so whichever lands second
     -- fills in the half the first one could not know.
     ON CONFLICT(id) DO UPDATE SET
       message_id        = coalesce(excluded.message_id, tool_call.message_id),
       model             = coalesce(excluded.model, tool_call.model),
       attribution_skill = coalesce(excluded.attribution_skill, tool_call.attribution_skill),
       ts_call           = coalesce(excluded.ts_call, tool_call.ts_call),
       ts_result         = coalesce(excluded.ts_result, tool_call.ts_result),
       tool_name         = CASE WHEN excluded.tool_name = '' THEN tool_call.tool_name ELSE excluded.tool_name END,
       skill_name        = coalesce(excluded.skill_name, tool_call.skill_name),
       file_path         = coalesce(excluded.file_path, tool_call.file_path),
       command           = coalesce(excluded.command, tool_call.command),
       is_error          = coalesce(excluded.is_error, tool_call.is_error),
       interrupted       = coalesce(excluded.interrupted, tool_call.interrupted),
       exit_code         = coalesce(excluded.exit_code, tool_call.exit_code),
       duration_ms       = coalesce(excluded.duration_ms, tool_call.duration_ms),
       git_operation     = coalesce(excluded.git_operation, tool_call.git_operation),
       result_bytes      = coalesce(excluded.result_bytes, tool_call.result_bytes),
       src_file          = excluded.src_file,
       src_line_call     = coalesce(excluded.src_line_call, tool_call.src_line_call),
       src_line_result   = coalesce(excluded.src_line_result, tool_call.src_line_result),
       extra             = coalesce(excluded.extra, tool_call.extra)`,
  );

  const clearGitCommands = db.prepare("DELETE FROM git_command WHERE tool_call_id = ?");
  const insertGitCommand = db.prepare(
    "INSERT INTO git_command (tool_call_id, position, subcommand) VALUES (?, ?, ?)",
  );

  const insertSkillLoad = db.prepare(
    `INSERT INTO skill_load (session_id, message_id, ts, model, skill_name, how,
       body_chars, body_sha256, skill_path)
     VALUES ($sessionId, $messageId, $ts, $model, $skillName, $how,
       $bodyChars, $bodySha256, $skillPath)
     ON CONFLICT(session_id, message_id, skill_name, how) DO UPDATE SET
       body_chars  = coalesce(excluded.body_chars, skill_load.body_chars),
       body_sha256 = coalesce(excluded.body_sha256, skill_load.body_sha256),
       skill_path  = coalesce(excluded.skill_path, skill_load.skill_path),
       model       = coalesce(excluded.model, skill_load.model)`,
  );

  const deleteSkillLoads = db.prepare<void, [string]>("DELETE FROM skill_load WHERE session_id = ?");
  const deleteToolCalls = db.prepare<void, [string]>("DELETE FROM tool_call WHERE session_id = ?");
  const deleteTurns = db.prepare<void, [string]>("DELETE FROM turn WHERE session_id = ?");
  const deleteCost = db.prepare<void, [string]>("DELETE FROM session_cost_reported WHERE session_id = ?");
  const deleteUsage = db.prepare<void, [string]>("DELETE FROM usage WHERE session_id = ?");
  const deleteMessages = db.prepare<void, [string]>("DELETE FROM message WHERE session_id = ?");
  const deleteSession = db.prepare<void, [string]>("DELETE FROM session WHERE id = ?");
  const resetCursor = db.prepare<void, [string]>(
    "UPDATE source_file SET bytes_ingested = 0, lines_ingested = 0, cursor_state = NULL WHERE path = ?",
  );

  function resetSession(sessionId: string, path: string): void {
    deleteSkillLoads.run(sessionId);
    deleteToolCalls.run(sessionId);
    deleteCost.run(sessionId);
    deleteTurns.run(sessionId);
    deleteUsage.run(sessionId);
    deleteMessages.run(sessionId);
    deleteSession.run(sessionId);
    resetCursor.run(path);
  }

  function applyChunk(
    spec: FileSpec,
    parsed: ParsedChunk,
    bytes: number,
    lines: number,
    mtime: string,
  ): void {
    insertSourceFile.run(spec.path, spec.tool, spec.kind, spec.sessionId, mtime);
    const s = foldSession(parsed.session);
    upsertSession.run({
      $id: spec.sessionId,
      $tool: spec.tool,
      $parent: spec.parentId ?? null,
      $agentType: spec.agentType ?? null,
      $cwd: s.cwd ?? null,
      $worktree: worktreeOf(s.cwd),
      $project: s.project ?? null,
      $gitBranch: s.gitBranch ?? null,
      $cliVersion: s.cliVersion ?? null,
      $entrypoint: s.entrypoint ?? null,
      $startedAt: s.startedAt ?? null,
      $lastSeenAt: s.lastSeenAt ?? null,
      $firstModel: s.firstModel ?? null,
      $lastModel: s.lastModel ?? null,
      $title: s.title ?? null,
      $extra: s.extra ?? null,
    });

    for (const m of parsed.messages) {
      upsertMessage.run({
        $id: m.id,
        $sessionId: spec.sessionId,
        $ts: m.ts,
        $role: m.role,
        $model: m.model ?? null,
        $turnId: m.turnId ?? null,
        $promptSource: m.promptSource ?? null,
        $originKind: m.originKind ?? null,
        $isMeta: m.isMeta ? 1 : 0,
        $isSkillBody: m.isSkillBody ? 1 : 0,
        $attributionSkill: m.attributionSkill ?? null,
        $stopReason: m.stopReason ?? null,
        $interruptedMessageId: m.interruptedMessageId ?? null,
        $denialKind: m.denialKind ?? null,
        $userFeedback: m.userFeedback ?? null,
        $text: m.text ?? null,
        $textChars: m.text != null ? m.text.length : null,
        $srcFile: spec.path,
        $srcLine: m.srcLine,
        $extra: m.extra ?? null,
      });
    }

    for (const u of parsed.usage) {
      insertUsage.run({
        $responseId: u.responseId,
        $sessionId: spec.sessionId,
        $messageId: u.messageId ?? null,
        $ts: u.ts,
        $model: u.model ?? null,
        $inputTokens: u.inputTokens,
        $cacheReadTokens: u.cacheReadTokens,
        $cacheWriteTokens: u.cacheWriteTokens,
        $cacheWrite1hTokens: u.cacheWrite1hTokens ?? null,
        $outputTokens: u.outputTokens,
        $reasoningTokens: u.reasoningTokens ?? null,
        $attributionSkill: u.attributionSkill ?? null,
        $extra: u.extra ?? null,
      });
    }

    for (const t of parsed.turns) {
      upsertTurn.run({
        $sessionId: spec.sessionId,
        $turnId: t.turnId,
        $tsStart: t.tsStart ?? null,
        $tsEnd: t.tsEnd,
        $durationMs: t.durationMs ?? null,
        $messageCount: t.messageCount ?? null,
        $status: t.status,
        $model: t.model ?? null,
        $timeToFirstTokenMs: t.timeToFirstTokenMs ?? null,
      });
    }

    for (const t of parsed.toolCalls) {
      upsertToolCall.run({
        $id: t.id,
        $sessionId: spec.sessionId,
        $messageId: t.messageId ?? null,
        $model: t.model ?? null,
        $attributionSkill: t.attributionSkill ?? null,
        $tsCall: t.tsCall ?? null,
        $tsResult: t.tsResult ?? null,
        $toolName: t.toolName,
        $skillName: t.skillName ?? null,
        $filePath: t.filePath ?? null,
        $command: t.command ?? null,
        $isError: t.isError == null ? null : t.isError ? 1 : 0,
        $interrupted: t.interrupted == null ? null : t.interrupted ? 1 : 0,
        $exitCode: t.exitCode ?? null,
        $durationMs: t.durationMs ?? null,
        $gitOperation: t.gitOperation ?? null,
        $resultBytes: t.resultBytes ?? null,
        $srcFile: spec.path,
        $srcLineCall: t.srcLineCall ?? null,
        $srcLineResult: t.srcLineResult ?? null,
        $extra: t.extra ?? null,
      });

      if (t.command) {
        clearGitCommands.run(t.id);
        let position = 0;
        for (const subcommand of gitSubcommands(t.command)) {
          insertGitCommand.run(t.id, position, subcommand);
          position += 1;
        }
      }
    }

    for (const l of parsed.skillLoads) {
      insertSkillLoad.run({
        $sessionId: spec.sessionId,
        $messageId: l.messageId ?? null,
        $ts: l.ts,
        $model: l.model ?? null,
        $skillName: l.skillName,
        $how: l.how,
        $bodyChars: l.bodyChars ?? null,
        $bodySha256: l.bodySha256 ?? null,
        $skillPath: l.skillPath ?? null,
      });
    }

    for (const c of parsed.costs) {
      upsertCost.run({
        $sessionId: spec.sessionId,
        $reportedBy: c.reportedBy,
        $totalCostUsd: c.totalCostUsd ?? null,
        $modelUsage: c.modelUsage,
        $hasUnknownModelCost: c.hasUnknownModelCost == null ? null : c.hasUnknownModelCost ? 1 : 0,
        $ts: c.ts ?? null,
      });
    }

    db.run(
      `UPDATE source_file SET bytes_ingested = ?, lines_ingested = ?,
         cursor_state = coalesce(?, cursor_state),
         origin_mtime = ?, ingested_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE path = ?`,
      [bytes, lines, parsed.cursorState ?? null, mtime, spec.path],
    );
  }

  function ingestFile(spec: FileSpec): FileResult {
    const stat = statSync(spec.path);
    const mtime = new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");

    const existing = selectCursor.get(spec.sessionId, spec.kind);
    if (existing && existing.path !== spec.path) {
      movePath.run(spec.path, spec.sessionId, spec.kind);
    }

    let cursor = existing?.bytes_ingested ?? 0;
    let lines = existing?.lines_ingested ?? 0;
    let state = existing?.cursor_state ?? null;
    let reset = false;

    if (stat.size < cursor) {
      resetSession(spec.sessionId, spec.path);
      cursor = 0;
      lines = 0;
      state = null;
      reset = true;
    }
    const nothing = { read: false, bytes: 0, lines: 0, reset, dropped: [] };
    if (stat.size === cursor) return nothing;

    const chunk = readChunk(spec.path, cursor);
    if (chunk.bytes === 0) return nothing;

    const parsed = spec.parse(chunk.lines, lines + 1, state);
    db.transaction(() => {
      applyChunk(spec, parsed, cursor + chunk.bytes, lines + chunk.lines.length, mtime);
    })();

    return {
      read: true,
      bytes: chunk.bytes,
      lines: chunk.lines.length,
      reset,
      dropped: parsed.dropped,
    };
  }

  return { ingestFile, resetSession };
}

export type Ingester = ReturnType<typeof createIngester>;

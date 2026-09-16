import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { readChunk } from "./chunk";
import type { ParsedChunk, SessionFacts } from "./records";

export type Tool = "claude" | "codex";
export type Kind = "transcript" | "subagent" | "rollout";

export type FileSpec = {
  path: string;
  tool: Tool;
  kind: Kind;
  sessionId: string;
  parentId?: string;
  agentType?: string;
  /** `state` is whatever this file's previous chunk left in cursor_state. */
  parse: (lines: string[], firstLineNumber: number, state: string | null) => ParsedChunk;
};

export type FileResult = { read: boolean; bytes: number; lines: number; reset: boolean };

// Repeated verbatim in text_chars so the stored length always matches the text.
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
  // ON UPDATE CASCADE carries message.src_file along, so locators stay valid
  // when Codex moves a rollout into archived_sessions/.
  const movePath = db.prepare<void, [string, string, string]>(
    "UPDATE source_file SET path = ? WHERE session_id = ? AND kind = ?",
  );
  const insertSourceFile = db.prepare<void, [string, string, string, string, string]>(
    `INSERT INTO source_file (path, tool, kind, session_id, origin_mtime)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (id, tool, parent_id, agent_type, cwd, project, git_branch, cli_version,
       entrypoint, started_at, last_seen_at, first_model, last_model, title, extra)
     VALUES ($id, $tool, $parent, $agentType, $cwd, $project, $gitBranch, $cliVersion,
       $entrypoint, $startedAt, $lastSeenAt, $firstModel, $lastModel, $title, $extra)
     ON CONFLICT(id) DO UPDATE SET
       parent_id    = coalesce(session.parent_id, excluded.parent_id),
       agent_type   = coalesce(session.agent_type, excluded.agent_type),
       cwd          = coalesce(session.cwd, excluded.cwd),
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

  const deleteUsage = db.prepare<void, [string]>("DELETE FROM usage WHERE session_id = ?");
  const deleteMessages = db.prepare<void, [string]>("DELETE FROM message WHERE session_id = ?");
  const deleteSession = db.prepare<void, [string]>("DELETE FROM session WHERE id = ?");
  const resetCursor = db.prepare<void, [string]>(
    "UPDATE source_file SET bytes_ingested = 0, lines_ingested = 0, cursor_state = NULL WHERE path = ?",
  );

  function resetSession(sessionId: string, path: string): void {
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
    if (stat.size === cursor) return { read: false, bytes: 0, lines: 0, reset };

    const chunk = readChunk(spec.path, cursor);
    if (chunk.bytes === 0) return { read: false, bytes: 0, lines: 0, reset };

    const parsed = spec.parse(chunk.lines, lines + 1, state);
    db.transaction(() => {
      applyChunk(spec, parsed, cursor + chunk.bytes, lines + chunk.lines.length, mtime);
    })();

    return { read: true, bytes: chunk.bytes, lines: chunk.lines.length, reset };
  }

  return { ingestFile, resetSession };
}

export type Ingester = ReturnType<typeof createIngester>;

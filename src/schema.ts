// Every table here is one-to-one with records in the source files and is rebuilt
// by re-reading them, so a schema change is `dim rebuild`, not a migration.
// SCHEMA_VERSION exists only so sync can refuse to run against an older shape.

export const SCHEMA_VERSION = 7;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- One row per source file on disk. The cursor is keyed by session, not by path:
-- Codex moves rollouts into archived_sessions/, and re-reading a moved file from
-- byte zero would append its assistant text a second time.
CREATE TABLE IF NOT EXISTS source_file (
  path            TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  kind            TEXT NOT NULL CHECK (kind IN ('transcript','subagent','rollout')),
  session_id      TEXT NOT NULL,
  bytes_ingested  INTEGER NOT NULL DEFAULT 0,
  lines_ingested  INTEGER NOT NULL DEFAULT 0,
  cursor_state    TEXT,
  origin_mtime    TEXT,
  ingested_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS source_file_session ON source_file(session_id, kind);

CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  parent_id       TEXT REFERENCES session(id),
  agent_type      TEXT,
  cwd             TEXT,
  project         TEXT,
  git_branch      TEXT,
  cli_version     TEXT,
  entrypoint      TEXT,
  started_at      TEXT,
  last_seen_at    TEXT,
  ended_at        TEXT,
  end_reason      TEXT,
  first_model     TEXT,
  last_model      TEXT,
  title           TEXT,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS session_project ON session(project, started_at);

-- Claude assistant content-block lines sharing a message.id collapse into one
-- row; Codex is one row per response_item message.
CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  ts              TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  model           TEXT,
  turn_id         TEXT,
  prompt_source   TEXT,
  origin_kind     TEXT,
  is_meta         INTEGER NOT NULL DEFAULT 0,
  is_skill_body   INTEGER NOT NULL DEFAULT 0,
  attribution_skill TEXT,
  stop_reason     TEXT,
  interrupted_message_id TEXT,
  denial_kind     TEXT,
  user_feedback   TEXT,
  text            TEXT,
  text_chars      INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line        INTEGER NOT NULL,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS message_session_ts ON message(session_id, ts);
CREATE INDEX IF NOT EXISTS message_attr ON message(attribution_skill);

-- The only table token sums come from. input_tokens is stored as each tool
-- reports it: Claude excludes cached reads from it, Codex includes them, so no
-- column adds the two tools together.
CREATE TABLE IF NOT EXISTS usage (
  response_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT,
  input_tokens    INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER,
  output_tokens   INTEGER NOT NULL,
  reasoning_tokens INTEGER,
  attribution_skill TEXT,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
CREATE INDEX IF NOT EXISTS usage_model ON usage(model);

-- Drained from the hook spool, and the one table \`dim rebuild\` must not touch:
-- a transcript records no end marker, so a session that ended before its hook
-- was installed can never be told apart from one still open. There is no
-- foreign key to session because a hook can fire for a session whose transcript
-- has not been read yet, or ever.
CREATE TABLE IF NOT EXISTS hook_event (
  id          INTEGER PRIMARY KEY,
  tool        TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  session_id  TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('session_start','session_end')),
  ts          TEXT NOT NULL,
  source      TEXT,               -- SessionStart: startup|resume|clear|compact|fork
  reason      TEXT,               -- SessionEnd: clear|resume|logout|prompt_input_exit|other
  model       TEXT,
  cwd         TEXT,
  payload     TEXT NOT NULL,      -- the hook's stdin, verbatim
  UNIQUE (session_id, event, ts)
);
CREATE INDEX IF NOT EXISTS hook_event_session ON hook_event(session_id);

CREATE TABLE IF NOT EXISTS turn (
  session_id      TEXT NOT NULL REFERENCES session(id),
  turn_id         TEXT NOT NULL,        -- Codex turn_id; Claude the turn_duration uuid
  ts_start        TEXT,
  ts_end          TEXT NOT NULL,
  duration_ms     INTEGER,
  message_count   INTEGER,              -- Claude only
  status          TEXT,                 -- completed | interrupted | <Codex abort reason>
  model           TEXT,
  time_to_first_token_ms INTEGER,       -- Codex only
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, ts_end);

-- Cost only where the tool computed it. This database carries no price table
-- and derives no dollar figure; Codex reports none at all.
CREATE TABLE IF NOT EXISTS session_cost_reported (
  session_id      TEXT PRIMARY KEY REFERENCES session(id),
  reported_by     TEXT NOT NULL,
  total_cost_usd  REAL,
  model_usage     TEXT NOT NULL,        -- JSON as written
  has_unknown_model_cost INTEGER,
  ts              TEXT
);

-- Typed prompts whose transcript no longer exists. Both tools keep a flat
-- history of what was typed, and it outlived the transcripts that were pruned
-- before retention was extended: for those sessions this is all that is left.
-- No foreign key, because by definition these sessions have no row.
CREATE TABLE IF NOT EXISTS orphan_prompt (
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  session_id      TEXT NOT NULL,
  ts              TEXT NOT NULL,
  project         TEXT,
  text            TEXT NOT NULL,
  PRIMARY KEY (tool, session_id, ts, text)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS orphan_prompt_session ON orphan_prompt(session_id);

-- One row per tool call. The call and its result are separate records in both
-- formats, so a row is written twice: once from the call, once from the result.
-- What the tool returned is never stored, only how big it was and whether it
-- failed; the bytes stay in the source file, reachable by src_line_result.
CREATE TABLE IF NOT EXISTS tool_call (
  id              TEXT PRIMARY KEY,     -- toolu_… / Codex item id
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  model           TEXT,
  attribution_skill TEXT,
  ts_call         TEXT,                 -- null when only the result was seen
  ts_result       TEXT,
  tool_name       TEXT NOT NULL,
  skill_name      TEXT,                 -- the Skill tool's input.skill
  file_path       TEXT,
  command         TEXT,
  is_error        INTEGER,
  interrupted     INTEGER,
  denial_kind     TEXT,
  exit_code       INTEGER,              -- Codex records one; Claude does not
  duration_ms     INTEGER,
  git_operation   TEXT,
  result_bytes    INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line_call   INTEGER,
  src_line_result INTEGER,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS tool_call_session ON tool_call(session_id, ts_call);
CREATE INDEX IF NOT EXISTS tool_call_name ON tool_call(tool_name);
CREATE INDEX IF NOT EXISTS tool_call_file ON tool_call(file_path);

-- Every time a skill's body entered the context window. The body itself is not
-- stored, only its size and hash: it is recoverable from the source file by
-- locator, and the hash is what dates it against the skills repo's history
-- without depending on that working tree having been clean.
CREATE TABLE IF NOT EXISTS skill_load (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT,
  skill_name      TEXT NOT NULL,
  how             TEXT NOT NULL CHECK (how IN ('model','user','read')),
      -- model: the Skill tool chose it; user: typed /name or $name;
      -- read: the model opened SKILL.md itself, which is Codex's usual path
  body_chars      INTEGER,
  body_sha256     TEXT,
  skill_path      TEXT,
  UNIQUE (session_id, message_id, skill_name, how)
);
CREATE INDEX IF NOT EXISTS skill_load_name ON skill_load(skill_name, ts);

-- The owner's judgement on a candidate correction, and the only table anything
-- other than the ingester writes. Nothing derives a correction automatically:
-- whether a prompt tells the agent it was wrong is semantic, and no rule here
-- decides it.
CREATE TABLE IF NOT EXISTS correction_label (
  message_id      TEXT PRIMARY KEY REFERENCES message(id),
  label           TEXT NOT NULL CHECK (label IN ('correction','clarification','not_correction')),
  skill_name      TEXT,
  rule            TEXT,                 -- which instruction was overridden, in the owner's words
  labeled_at      TEXT NOT NULL
);
`;

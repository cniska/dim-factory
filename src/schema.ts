// Every table here is one-to-one with records in the source files and is rebuilt
// by re-reading them, so a schema change is `dim rebuild`, not a migration. The
// exceptions carry the reason at the table: hook_event, guidance_walk and finding
// have no source to re-read, and embedding is derived from tables that do.
// SCHEMA_VERSION exists so sync can refuse to run against a database only a
// re-read can correct: a changed column, or a changed rule for what identifies a
// row, since rows already written keep the old identity. A table added with
// nothing existing feeding it is neither — every write opens the database
// through SCHEMA_SQL, which creates it — so adding one is not a version bump.

import { TOOLS_SQL } from "./tools";

export const SCHEMA_VERSION = 16;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- One row per source file on disk. The cursor is keyed by session, not by path:
-- Codex moves rollouts into archived_sessions/, and re-reading a moved file from
-- byte zero would append its assistant text a second time.
CREATE TABLE IF NOT EXISTS source_file (
  path            TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
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
  worktree        TEXT,                 -- the task worktree cwd sits in, null in a primary checkout
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
  tool        TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
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

-- Which rules files were in force together when a session started, and which one
-- imported which. guidance_version records what each file said; this records that
-- they were read as one set, which nothing else holds: the same project file
-- governs different work depending on what sat above it. Written from the
-- SessionStart hook and, like hook_event, never cleared by \`rebuild\` — a file
-- edited since cannot be read back as it was. No foreign key, for the same
-- reason: the hook fires before the transcript has been read, or ever.
CREATE TABLE IF NOT EXISTS guidance_walk (
  session_id  TEXT NOT NULL,
  tool        TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
  seen_at     TEXT NOT NULL,
  path        TEXT NOT NULL,       -- absolute, as the agent would read it
  blob_sha    TEXT NOT NULL,       -- sha256 of the bytes read, joining to guidance_version
  imported_by TEXT,                -- the surface whose import pulled this one in
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS guidance_walk_path ON guidance_walk(path, seen_at);

-- One row per traced invocation. Which commands an agent runs is already in
-- tool_call, because every one is a shell call in a transcript; what is not
-- anywhere else is which branch answered — \`q search\` falling back from cosine
-- to the keyword index is invisible in its rows — and any run from a terminal,
-- which belongs to no session. Like hook_event it has no source to re-read, so
-- \`rebuild\` never clears it.
CREATE TABLE IF NOT EXISTS command_trace (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  command     TEXT NOT NULL,       -- the dim subcommand; only q writes one today
  name        TEXT,                -- the query name, where the command is q
  path        TEXT,                -- which branch answered, where the query names one
  row_count   INTEGER,
  duration_ms INTEGER,
  cwd         TEXT
);
CREATE INDEX IF NOT EXISTS command_trace_name ON command_trace(command, name, ts);

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
  tool            TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
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

-- The git a session actually ran, read from the command line. One shell call
-- runs several often enough that this is a row per operation rather than a
-- column: "git add -A && git commit" is one tool_call and two operations.
-- tool_call.git_operation is the tool's own metadata beside this, and covers
-- push, branch and PR only, on Claude alone.
CREATE TABLE IF NOT EXISTS git_command (
  tool_call_id    TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,     -- order within the one shell command
  subcommand      TEXT NOT NULL,
  PRIMARY KEY (tool_call_id, position)
);
CREATE INDEX IF NOT EXISTS git_command_sub ON git_command(subcommand);

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

-- The owner's judgement on a candidate correction. Nothing derives a correction
-- automatically: whether a prompt tells the agent it was wrong is semantic, and
-- no rule here decides it. Written by \`dim label\`, as \`finding\` is written by
-- \`dim finding\`; every other table is the ingester's.
CREATE TABLE IF NOT EXISTS correction_label (
  message_id      TEXT PRIMARY KEY REFERENCES message(id),
  label           TEXT NOT NULL CHECK (label IN ('correction','clarification','not_correction')),
  skill_name      TEXT,
  rule            TEXT,                 -- which instruction was overridden, in the owner's words
  labeled_at      TEXT NOT NULL
);

-- No source to re-read — an answer exists only in the session that made it — so
-- \`rebuild\` never clears this, as it does not clear hook_event. Grades the
-- checker and never the builder: measures in docs/findings.md looked like grades
-- and turned out to track what was being worked on instead.
CREATE TABLE IF NOT EXISTS finding (
  id           INTEGER PRIMARY KEY,
  repo         TEXT NOT NULL,        -- as repo_commit spells it, so a row reaches commit_file
  slice        TEXT NOT NULL,
  dimension    TEXT NOT NULL,        -- which of the checker's four questions raised it
  file         TEXT,                 -- relative to the checkout
  summary      TEXT NOT NULL,        -- the checker's words, not the builder's
  answer       TEXT NOT NULL CHECK (answer IN ('fixed','refused')),
  reason       TEXT,
  recorded_at  TEXT NOT NULL,
  -- A refusal with no reason is the cheap way out the loop exists to prevent.
  CHECK (answer <> 'refused' OR (reason IS NOT NULL AND trim(reason) <> ''))
);
CREATE INDEX IF NOT EXISTS finding_repo ON finding(repo, file);

-- The only outcome signal here. Everything else in this database is process — what
-- was said, loaded, called, stopped — and process cannot say whether the work was
-- right. A later commit that fixes a file is the repo's own verdict on an earlier
-- change to it, written by whoever had to come back.
CREATE TABLE IF NOT EXISTS repo_commit (
  sha             TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,        -- git toplevel: one row per checkout, worktrees included
  label           TEXT,                 -- owner/repo from the remote; the identity a worktree shares
  ts              TEXT NOT NULL,        -- author date, ISO, UTC
  author          TEXT,
  subject         TEXT NOT NULL,
  kind            TEXT                  -- Conventional Commits type: fix, feat, docs, …
);
CREATE INDEX IF NOT EXISTS repo_commit_repo_ts ON repo_commit(repo, ts);

CREATE TABLE IF NOT EXISTS commit_file (
  sha             TEXT NOT NULL REFERENCES repo_commit(sha) ON DELETE CASCADE,
  -- Absolute, not the repo-relative path git reports: a tool call records the
  -- absolute path, and joining on a path assembled in SQL cannot use an index.
  path            TEXT NOT NULL,
  PRIMARY KEY (sha, path)
);
CREATE INDEX IF NOT EXISTS commit_file_path ON commit_file(path);

-- What each repo tracks right now, replaced whole on every sync. commit_file
-- answers what a repo once held: a rename is a delete and an add there, and a
-- file deleted years ago still has its rows. A reader looking for how a problem
-- was solved before needs a path that opens, which is this table.
CREATE TABLE IF NOT EXISTS repo_file (
  repo            TEXT NOT NULL,        -- git toplevel, as in repo_commit
  path            TEXT NOT NULL,        -- absolute, as in commit_file
  PRIMARY KEY (repo, path)
);
CREATE INDEX IF NOT EXISTS repo_file_path ON repo_file(path);

-- Which version of a rules file was in force when a session ran. Skills carry a
-- body hash on every load; AGENTS.md and CLAUDE.md are loaded in every session and
-- carried none, so the 82% of edits made under no skill could not be split by the
-- guidance that governed them. Versions inside a repo come from git and reach back
-- as far as its history; a file outside one is only ever seen from the first sync
-- that read it, which is why waiting costs something no rebuild can return.
CREATE TABLE IF NOT EXISTS guidance_version (
  path            TEXT NOT NULL,        -- absolute, as an agent would read it
  blob_sha        TEXT NOT NULL,        -- git blob id, or sha256 for a file outside a repo
  first_seen      TEXT NOT NULL,        -- commit date, or the sync that first saw it
  last_seen       TEXT NOT NULL,
  bytes           INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('git','snapshot')),
  PRIMARY KEY (path, blob_sha)
);
CREATE INDEX IF NOT EXISTS guidance_version_seen ON guidance_version(path, first_seen);

-- What \`q search\` ranks: only text a person already distilled, for the reasons in
-- docs/recall.md. A projection of its sources and never a second archive —
-- \`dim embed\` drops the row when the source is gone.
--
-- No foreign key, because \`rebuild\` empties message and drops repo_commit and
-- then writes the same ids back, so a vector keyed by one survives it. text is
-- stored rather than joined because a vector only means anything against the
-- exact string the model was given, and a Next is a slice of a larger message
-- that exists nowhere else.
CREATE TABLE IF NOT EXISTS embedding (
  kind        TEXT NOT NULL CHECK (kind IN ('next','subject','correction')),
  ref         TEXT NOT NULL,        -- message.id, or repo_commit.sha for a subject
  text        TEXT NOT NULL,
  text_sha    TEXT NOT NULL,        -- so a re-run embeds only what changed
  vector      BLOB NOT NULL,        -- 384 little-endian float32, unit length
  model       TEXT NOT NULL,
  built_at    TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Which session continued which. session.parent_id links a subagent to its
-- parent and nothing else links a session to the one it carried on from, so a
-- task spanning several sessions reads as unrelated cold starts and every
-- per-session measure is distorted by the chain depth behind it. Derived from
-- text already collected, so it carries no foreign key and is replaced whole on
-- every sync, as repo_file is. One row per paste: a handoff printed twice and
-- pasted twice is two edges.
CREATE TABLE IF NOT EXISTS handoff_link (
  to_message      TEXT PRIMARY KEY,     -- the user message that pasted it forward
  to_session      TEXT NOT NULL,
  to_ts           TEXT NOT NULL,
  from_message    TEXT NOT NULL,        -- the assistant message that printed it
  from_session    TEXT NOT NULL,
  from_ts         TEXT NOT NULL,
  title           TEXT NOT NULL         -- the heading line, which is what the two sides share
);
CREATE INDEX IF NOT EXISTS handoff_link_from ON handoff_link(from_session);
CREATE INDEX IF NOT EXISTS handoff_link_to ON handoff_link(to_session);

-- Prose search over message.text, so finding what was said in a past session is a
-- query rather than a grep across every transcript on disk. External content: the
-- index stores no copy of the text and reads it back through message.rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content = 'message',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

-- The ingester upserts, so a row arriving twice fires the update trigger rather
-- than a second insert; all three keep the index level with the table.
CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
`;

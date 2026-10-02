import { HarnessName } from "./harness-contract";
import { HOOK_EVENTS } from "./hook-events";
import { TOOLS } from "./ingest-tools";

const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(",");
const TOOLS_SQL = sqlList(TOOLS);
const HARNESSES_SQL = sqlList(HarnessName.options);
const HOOK_EVENTS_SQL = sqlList(Object.values(HOOK_EVENTS));

export const SCHEMA_VERSION = 95;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_file (
  path            TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
  kind            TEXT NOT NULL CHECK (kind IN ('transcript','subagent','rollout')),
  session_id      TEXT NOT NULL,
  bytes_ingested  INTEGER NOT NULL DEFAULT 0,
  lines_ingested  INTEGER NOT NULL DEFAULT 0,
  cursor_state    TEXT,
  ingested_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS source_file_session ON source_file(session_id, kind);

CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
  parent_id       TEXT REFERENCES session(id),
  agent_type      TEXT,
  cwd             TEXT,
  worktree        TEXT,
  project         TEXT,
  git_branch      TEXT,
  cli_version     TEXT,
  entrypoint      TEXT,
  started_at      TEXT,
  last_seen_at    TEXT,
  ended_at        TEXT,
  end_reason      TEXT,
  title           TEXT
);
CREATE INDEX IF NOT EXISTS session_project ON session(project, started_at);

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

CREATE TABLE IF NOT EXISTS usage (
  response_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT,
  input_tokens    INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL,
  attribution_skill TEXT
);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
CREATE INDEX IF NOT EXISTS usage_model ON usage(model);

CREATE TABLE IF NOT EXISTS hook_event (
  id          INTEGER PRIMARY KEY,
  tool        TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
  session_id  TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN (${HOOK_EVENTS_SQL})),
  ts          TEXT NOT NULL,
  harness_pid INTEGER,
  reason      TEXT,
  cwd         TEXT,
  UNIQUE (session_id, event, ts)
);
CREATE INDEX IF NOT EXISTS hook_event_session ON hook_event(session_id);

CREATE TABLE IF NOT EXISTS turn (
  session_id      TEXT NOT NULL REFERENCES session(id),
  turn_id         TEXT NOT NULL,
  ts_start        TEXT,
  ts_end          TEXT,
  duration_ms     INTEGER,
  message_count   INTEGER,
  status          TEXT,
  model           TEXT,
  time_to_first_token_ms INTEGER,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, ts_end);

CREATE TABLE IF NOT EXISTS tool_call (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  model           TEXT,
  attribution_skill TEXT,
  ts_call         TEXT,
  ts_result       TEXT,
  tool_name       TEXT NOT NULL,
  skill_name      TEXT,
  file_path       TEXT,
  command         TEXT,
  is_error        INTEGER,
  interrupted     INTEGER,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  git_operation   TEXT,
  result_bytes    INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line_call   INTEGER,
  src_line_result INTEGER
);
CREATE INDEX IF NOT EXISTS tool_call_session ON tool_call(session_id, ts_call);
CREATE INDEX IF NOT EXISTS tool_call_name ON tool_call(tool_name);
CREATE INDEX IF NOT EXISTS tool_call_file ON tool_call(file_path);

CREATE TABLE IF NOT EXISTS git_command (
  tool_call_id    TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  subcommand      TEXT NOT NULL,
  PRIMARY KEY (tool_call_id, position)
);
CREATE INDEX IF NOT EXISTS git_command_sub ON git_command(subcommand);

CREATE TABLE IF NOT EXISTS skill_load (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT,
  skill_name      TEXT NOT NULL,
  how             TEXT NOT NULL CHECK (how IN ('model','user','read')),
  body_chars      INTEGER,
  body_sha256     TEXT,
  skill_path      TEXT,
  UNIQUE (session_id, message_id, skill_name, how)
);
CREATE INDEX IF NOT EXISTS skill_load_name ON skill_load(skill_name, ts);

CREATE TABLE IF NOT EXISTS repo_commit (
  sha             TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  label           TEXT,
  ts              TEXT NOT NULL,
  author          TEXT,
  subject         TEXT NOT NULL,
  kind            TEXT
);
CREATE INDEX IF NOT EXISTS repo_commit_repo_ts ON repo_commit(repo, ts);

CREATE TABLE IF NOT EXISTS commit_file (
  sha             TEXT NOT NULL REFERENCES repo_commit(sha) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  PRIMARY KEY (sha, path)
);
CREATE INDEX IF NOT EXISTS commit_file_path ON commit_file(path);

CREATE TABLE IF NOT EXISTS repo_file (
  repo            TEXT NOT NULL,
  path            TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);
CREATE INDEX IF NOT EXISTS repo_file_path ON repo_file(path);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content = 'message',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON message WHEN old.text IS NOT new.text BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS worker (
  name        TEXT PRIMARY KEY CHECK (name GLOB '[a-z]*-[0-9]*'),
  role        TEXT NOT NULL CHECK (role IN ('operator','planner','builder','reviewer')),
  project     TEXT NOT NULL,
  order_id    TEXT,
  created_by  TEXT REFERENCES worker(name),
  CHECK ((role = 'operator') = (order_id IS NULL AND created_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_station ON worker(order_id, role) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS worker_operator ON worker(project) WHERE role = 'operator';

CREATE TABLE IF NOT EXISTS worker_session (
  id              TEXT PRIMARY KEY,
  worker          TEXT NOT NULL REFERENCES worker(name),
  harness         TEXT NOT NULL CHECK (harness IN (${HARNESSES_SQL})),
  pid             INTEGER NOT NULL,
  pid_started_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_log (
  order_id        TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  worker          TEXT,
  session         TEXT,
  factory_version TEXT,
  cause           INTEGER,
  action          TEXT NOT NULL,
  code            TEXT,
  details         TEXT NOT NULL CHECK (json_valid(details)),
  evidence        TEXT CHECK (json_valid(evidence)),
  PRIMARY KEY (order_id, seq),
  FOREIGN KEY (order_id, cause) REFERENCES order_log(order_id, seq),
  CHECK ((worker IS NOT NULL AND session IS NOT NULL AND factory_version IS NULL AND cause IS NULL)
      OR (worker IS NULL AND session IS NULL AND factory_version IS NOT NULL AND cause IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS order_log_no_update BEFORE UPDATE ON order_log
BEGIN SELECT RAISE(ABORT, 'order_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS order_log_no_delete BEFORE DELETE ON order_log
BEGIN SELECT RAISE(ABORT, 'order_log is append-only'); END;

CREATE TABLE IF NOT EXISTS run (
  order_id            TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('station','ship')),
  pid                 INTEGER NOT NULL,
  pid_started_at      TEXT NOT NULL,
  harness_pid         INTEGER,
  harness_started_at  TEXT,
  CHECK ((harness_pid IS NULL) = (harness_started_at IS NULL))
);
`;

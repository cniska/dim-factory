import { HARNESSES_SQL } from "./harness-name";
import { TOOLS_SQL } from "./ingest-tools";
import { ATTEMPT_OUTCOMES_SQL, ORDER_EVENT_KINDS_SQL } from "./order-events";
import { ORDER_LINES_SQL } from "./order-line";
import { ORDER_STATUSES_SQL } from "./order-status";
import { STATIONS_SQL } from "./station";
import { ROLES_SQL } from "./worker-roles";

export const SCHEMA_VERSION = 66;

export const SCHEMA_SQL = `
-- Not dropped by \`rebuild\`, which writes this row itself once the re-read has
-- returned; a drop would take the version with it.
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

-- Drained from the hook spool, which deletes each file once it is read, so these
-- rows have no source: \`dim rebuild\` reads them out and writes them back rather
-- than clearing them. A transcript records no end marker, so a session that ended
-- before its hook was installed can never be told apart from one still open. There
-- is no foreign key to session because a hook can fire for a session whose
-- transcript has not been read yet, or ever.
CREATE TABLE IF NOT EXISTS hook_event (
  id          INTEGER PRIMARY KEY,
  tool        TEXT NOT NULL CHECK (tool IN (${TOOLS_SQL})),
  session_id  TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('session_start','session_end','post_tool_use')),
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

-- One ordered, diagnostic event stream. It is deliberately separate from the
-- factory order audit: trace explains execution, while order events prove
-- attributed business actions. Like hook_event it has no source to re-read, so
-- \`rebuild\` never clears it.
CREATE TABLE IF NOT EXISTS trace_event (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  event         TEXT NOT NULL,
  order_id      TEXT,
  attempt_id    TEXT,
  station       TEXT,
  worker        TEXT,
  session_id    TEXT,
  command       TEXT,
  name          TEXT,
  path          TEXT,
  row_count     INTEGER,
  duration_ms   INTEGER,
  cwd           TEXT,
  fields        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS trace_event_order_ts ON trace_event(order_id, ts, id);
CREATE INDEX IF NOT EXISTS trace_event_name ON trace_event(event, name, ts);

-- Persisted scheduler definitions are operational control state, not source-derived
-- rows and not factory order execution reports. The latest evaluation fields let the
-- next invocation explain when a schedule was last considered without a second report store.
CREATE TABLE IF NOT EXISTS factory_schedule (
  id                  TEXT PRIMARY KEY,
  queue_id            TEXT NOT NULL,
  interval_seconds    INTEGER NOT NULL CHECK (interval_seconds > 0),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_evaluated_at   TEXT,
  last_due_at         TEXT
);
CREATE INDEX IF NOT EXISTS factory_schedule_due ON factory_schedule(enabled, paused, last_evaluated_at);

-- What stops the whole factory rather than one queue: a defect hit mid-slice is in
-- the machinery every queue is run by, so the next claim is refused whichever repo
-- it was going to come from. Running orders are left alone, because killing a
-- worker mid-write leaves a worktree nobody owns and a commit half made.
--
-- A worker does not stop the factory. One that hits a defect fails its own attempt,
-- which is already how it says the owner has to look, and the operator stops the
-- floor having seen whether the defect is in the machinery or in the one piece of
-- work. Nothing in the database can tell who ran the command, so that is held by
-- dim factory stop and not by a constraint.
--
-- A live stop is a row with no cleared_at rather than a flag, so there is no second
-- copy of the state to go stale, and the index is what holds the floor to one stop
-- at a time. The reason is required: a stopped factory nobody can explain is one
-- the next operator clears to get moving.
CREATE TABLE IF NOT EXISTS factory_stop (
  id              INTEGER PRIMARY KEY,
  reason          TEXT NOT NULL CHECK (trim(reason) <> ''),
  pulled_by       TEXT NOT NULL,
  pulled_at       TEXT NOT NULL,
  -- Where the defect surfaced, where it surfaced under an order at all.
  order_id        TEXT,
  cleared_at      TEXT,
  cleared_by      TEXT,
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_stop_live
  ON factory_stop((cleared_at IS NULL)) WHERE cleared_at IS NULL;

-- Every piece of work, waiting or worked, and the evidence of what it produced.
-- Nothing on disk holds it and no source could reproduce a claim, event or report
-- after the fact, so rebuild writes these rows back rather than re-reading them.
-- An order is queued before any worker exists, which is why the run, the agent and
-- the claim time are set later rather than at creation.
-- Which session a worker turned out to be running, learned from the spool filename the
-- hook wrote in the environment the factory started that worker in. It is a fact about
-- the worker and never about a moment, so a session that never arrives leaves nothing
-- incomplete: the log already names the worker, and this only says where to read its
-- transcript. A worker can be seen in more than one session, and each sighting is its
-- own row rather than a column anything overwrites.
CREATE TABLE IF NOT EXISTS factory_worker_session (
  worker        TEXT REFERENCES factory_worker(name),
  session_id    TEXT NOT NULL,
  seen_at       TEXT NOT NULL,
  PRIMARY KEY (worker, session_id)
);

CREATE TABLE IF NOT EXISTS factory_order (
  -- The subject, which is also the branch and the worktree directory it will be
  -- built in: one string the record states once rather than three that can
  -- disagree. It exists before any run, so it carries no run timestamp.
  id              TEXT PRIMARY KEY,
  -- The canonical owner/repo the work belongs to, so one board carries more than
  -- one project and a path cannot stand in for an identity.
  project         TEXT NOT NULL,
  -- What the order is called, so a card can be read across a room. The id beside
  -- it is what a query joins on and never what a person is shown.
  title           TEXT NOT NULL,
  line            TEXT NOT NULL DEFAULT 'feat'
                  CHECK (line IN (${ORDER_LINES_SQL})),
  description     TEXT,
  -- Ready orders come back most urgent first, unset last, then oldest, then id.
  -- Named rather than numbered so a row reads without a key, and five levels
  -- because a tracker feeding this queue has about that many to hand over.
  priority        TEXT NOT NULL DEFAULT 'unset'
                  CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'unset')),
  -- One status per column on the board, except dropped, which leaves the board rather
  -- than taking a column: a decision not to work is none of todo, active or done. A
  -- started order stays working through a failure, since its evidence still says where
  -- it is; the station it is at is read from that evidence and never stored.
  status          TEXT NOT NULL CHECK (status IN (${ORDER_STATUSES_SQL})),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT,
  stop_reason     TEXT
);

CREATE TABLE IF NOT EXISTS factory_order_attempt (
  id              INTEGER PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL,
  worker          TEXT NOT NULL REFERENCES factory_worker(name),
  operator_worker TEXT REFERENCES factory_worker(name),
  session_id      TEXT,
  provider_session_id TEXT,
  station         TEXT NOT NULL CHECK (station IN (${STATIONS_SQL})),
  harness         TEXT,
  model           TEXT,
  tier            TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  recorded_at     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('started', 'finished')),
  outcome         TEXT NOT NULL CHECK (outcome IN (${ATTEMPT_OUTCOMES_SQL})),
  reason          TEXT
);
CREATE INDEX IF NOT EXISTS factory_order_attempt_order ON factory_order_attempt(order_id, recorded_at, id);
CREATE INDEX IF NOT EXISTS factory_order_status ON factory_order(status, updated_at);

-- Who did the work, issued by the factory before the work starts rather than read off
-- the harness after it. A \`dim order\` process is told nothing about which agent it
-- runs as, so an identity it stated about itself would be testimony; this one is
-- minted here, handed to the worker in the environment it is started in, and written
-- on every moment by the statement that writes the moment.
--
-- Nothing on disk can reproduce a worker, so rebuild writes these rows back like the
-- rest of the factory records.
CREATE TABLE IF NOT EXISTS factory_worker (
  -- Issued rather than derived, so it is unique by construction and is what every
  -- moment names. A name hashed out of some other identity would trade that for
  -- collisions and would need the other identity to exist first.
  name          TEXT PRIMARY KEY,
  -- What the worker was called in as, fixed when it is issued: a builder stays a
  -- builder wherever its work sits, while the station says where the work is. The
  -- vocabulary is \`src/worker-roles.ts\`, which is also what the router reads a tier off,
  -- so a role the record refuses cannot be one the line routes. Under NOT NULL
  -- because a hand with no role is one nothing can route and nothing can draw.
  role          TEXT NOT NULL CHECK (role IN (${ROLES_SQL})),
  -- The worker that requested this one. Roots have no parent; a child never infers
  -- its parent from a session string, because session naming is not the audit record.
  parent_worker TEXT REFERENCES factory_worker(name),
  -- The session that holds this identity. One session can mint one worker; a station
  -- spawned child uses its own explicit session id.
  session_id    TEXT UNIQUE,
  -- The digest of the secret the worker carries, never the secret. The issued set is
  -- readable through \`dim sql\`, so without something only the worker holds, any
  -- worker could write under another's name. It is a capability rather than a
  -- credential: it is minted here, never leaves this machine, and stops working when
  -- the worker does.
  token_digest  TEXT NOT NULL,
  -- The process the worker runs as, so that it is over is a signal sent to a pid
  -- rather than a heartbeat something has to keep writing. A station worker resumes
  -- as a new process each run, and the runner writes that run's pid when it starts.
  -- NULL for a worker issued to a shell instead of to a process this spawned.
  pid           INTEGER,
  started_at    TEXT NOT NULL,
  -- The runner writes this when a station worker's run ends and clears it when the
  -- next run starts. A stopped pid is over whether or not this row was written,
  -- which keeps a killed worker from holding a live token.
  ended_at      TEXT
);

-- A station can assign a child before the harness has created that child's session.
-- Bootstrap supplies the session identity and creates the worker, so the factory never
-- invents a child identity.
CREATE TABLE IF NOT EXISTS factory_worker_assignment (
  id              TEXT PRIMARY KEY,
  parent_worker   TEXT NOT NULL REFERENCES factory_worker(name),
  role            TEXT NOT NULL CHECK (role IN (${ROLES_SQL})),
  token_digest    TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  accepted_at     TEXT,
  accepted_worker TEXT REFERENCES factory_worker(name),
  CHECK ((accepted_at IS NULL) = (accepted_worker IS NULL))
);
CREATE INDEX IF NOT EXISTS factory_worker_assignment_parent
  ON factory_worker_assignment(parent_worker, created_at);

-- The assignment for an order role is durable. A later turn gets the same worker
-- and provider session instead of creating another hand for the same work.
CREATE TABLE IF NOT EXISTS factory_order_worker (
  order_id             TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL CHECK (role IN ('planner', 'builder', 'reviewer')),
  assignment_id        TEXT NOT NULL UNIQUE REFERENCES factory_worker_assignment(id),
  worker               TEXT UNIQUE REFERENCES factory_worker(name),
  provider_session_id  TEXT,
  -- A provider session resumes only under the harness that started it. The default is
  -- what a rebuild gives a row written before the column existed, when codex was the
  -- only harness; every insert names its harness.
  harness              TEXT NOT NULL DEFAULT 'codex' CHECK (harness IN (${HARNESSES_SQL})),
  created_at           TEXT NOT NULL,
  PRIMARY KEY (order_id, role),
  CHECK ((worker IS NULL) = (provider_session_id IS NULL))
);
CREATE INDEX IF NOT EXISTS factory_order_worker_order ON factory_order_worker(order_id);

CREATE TABLE IF NOT EXISTS factory_order_event (
  id                    INTEGER PRIMARY KEY,
  order_id              TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  ts                    TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN (${ORDER_EVENT_KINDS_SQL})),
  -- Who did it, written by the statement that writes the moment and never after.
  -- A runner failure before a station worker bootstraps has no worker rather than
  -- borrowing the operator's identity.
  worker                TEXT REFERENCES factory_worker(name),
  session_id            TEXT,
  station               TEXT CHECK (station IN (${STATIONS_SQL})),
  commit_sha            TEXT,
  check_id              INTEGER,
  review_id             INTEGER,
  finding_id            INTEGER,
  answer_id             INTEGER REFERENCES factory_order_finding_answer(id) ON DELETE CASCADE,
  artifact_id           INTEGER REFERENCES factory_order_artifact(id) ON DELETE CASCADE,
  status                TEXT,
  reason                TEXT,
  evidence              TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS factory_order_event_order_ts ON factory_order_event(order_id, ts, id);

CREATE TABLE IF NOT EXISTS factory_schedule_invocation (
  id                    INTEGER PRIMARY KEY,
  schedule_id           TEXT NOT NULL REFERENCES factory_schedule(id),
  evaluated_at          TEXT NOT NULL,
  due                   INTEGER NOT NULL CHECK (due IN (0, 1)),
  dispatched            INTEGER NOT NULL CHECK (dispatched IN (0, 1)),
  selected_order_ids    TEXT NOT NULL DEFAULT '[]',
  worker                TEXT REFERENCES factory_worker(name),
  session_id            TEXT,
  harness               TEXT,
  model                 TEXT,
  tier                  TEXT,
  outcome               TEXT NOT NULL CHECK (outcome IN ('not_due', 'dispatched', 'failed')),
  reason                TEXT
);
CREATE INDEX IF NOT EXISTS factory_schedule_invocation_schedule
  ON factory_schedule_invocation(schedule_id, evaluated_at, id);

CREATE TABLE IF NOT EXISTS factory_order_delivery (
  id                    INTEGER PRIMARY KEY,
  order_id              TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('integration', 'delivery')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  target                TEXT,
  commit_sha            TEXT,
  worker                TEXT REFERENCES factory_worker(name),
  session_id            TEXT,
  recorded_at           TEXT NOT NULL,
  reason                TEXT
);

CREATE TABLE IF NOT EXISTS factory_order_commit (
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL,
  subject       TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (order_id, sha)
);

-- One rebase of an order's branch at ship. Append-only like the commits it rewrote: the
-- new commits get rows of their own, and each \`commit_rewritten\` event names the sha it
-- retires, so no recorded sha is ever changed in place. Written only once the re-check
-- at the new head passed, which is the check it names.
CREATE TABLE IF NOT EXISTS factory_order_rewrite (
  id            INTEGER PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  old_base      TEXT NOT NULL,
  new_base      TEXT NOT NULL,
  old_head      TEXT NOT NULL,
  new_head      TEXT NOT NULL,
  -- From \`git range-diff\`: 1 when every replayed commit carries the patch it had. Always 0
  -- where the builder resolved a conflict, since part of the rewrite is then its own.
  patch_equal   INTEGER NOT NULL CHECK (patch_equal IN (0, 1)),
  check_id      INTEGER NOT NULL REFERENCES factory_order_check(id),
  worker        TEXT NOT NULL REFERENCES factory_worker(name),
  recorded_at   TEXT NOT NULL
);

-- How much of each file the order changed, as the recorder counted it. Both
-- nullable: a path recorded without counts says only that the file was touched,
-- and git reports no line counts at all for a binary file.
CREATE TABLE IF NOT EXISTS factory_order_file (
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  worker        TEXT REFERENCES factory_worker(name),
  path          TEXT NOT NULL,
  added         INTEGER,
  removed       INTEGER,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (order_id, path)
);

CREATE TABLE IF NOT EXISTS factory_order_check (
  id            INTEGER PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  command       TEXT NOT NULL,
  exit_code     INTEGER NOT NULL,
  started_at    TEXT,
  finished_at   TEXT NOT NULL,
  result        TEXT,
  recorded_at   TEXT NOT NULL
);

-- One reading of one diff, named by the two shas that bound it rather than by the state
-- of a tree: a sha cannot move while it is being read, and a worktree can. The reviewer
-- is bound to the assignment when the round opens. Bootstrap supplies the worker name
-- before a finding is accepted, which binds it to the hand the factory spawned.
--
-- How it ended is written from the spawned process's exit code, never from anything the
-- reviewer says about itself: a reviewer that crashed and one that finished clean would
-- otherwise be told apart only by its own testimony.
CREATE TABLE IF NOT EXISTS factory_order_review (
  id            INTEGER PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  reviewer      TEXT REFERENCES factory_worker(name),
  assignment_id TEXT REFERENCES factory_worker_assignment(id),
  base_sha      TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  outcome       TEXT CHECK (outcome IN ('closed', 'aborted')),
  CHECK ((outcome IS NULL) = (closed_at IS NULL)),
  CHECK (reviewer IS NOT NULL OR assignment_id IS NOT NULL),
  UNIQUE (order_id, round)
);

-- What a station handed back, one row per revision. Who wrote it and when is its
-- artifact_written event, and an approval or a return is an event naming it, so the row
-- holds only what was written. A Build artifact names the commit it describes and a
-- Review artifact the round it reports, which also gives it the head that round read.
CREATE TABLE IF NOT EXISTS factory_order_artifact (
  id            INTEGER PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('plan', 'build', 'review')),
  revision      INTEGER NOT NULL CHECK (revision > 0),
  body          TEXT NOT NULL CHECK (trim(body) <> ''),
  head_sha      TEXT,
  review_id     INTEGER REFERENCES factory_order_review(id) ON DELETE CASCADE,
  CHECK ((kind = 'plan') = (head_sha IS NULL)),
  CHECK ((kind = 'review') = (review_id IS NOT NULL)),
  UNIQUE (order_id, kind, revision)
);

CREATE TABLE IF NOT EXISTS factory_order_finding (
  id            INTEGER PRIMARY KEY,
  -- The round that raised it, so a finding names the diff it was read against, the order
  -- that diff belongs to, and the reviewer the factory spawned for that round.
  review_id     INTEGER NOT NULL REFERENCES factory_order_review(id) ON DELETE CASCADE,
  dimension     TEXT NOT NULL,
  file          TEXT NOT NULL CHECK (trim(file) <> ''),
  line          INTEGER NOT NULL CHECK (line > 0),
  failure       TEXT NOT NULL CHECK (trim(failure) <> ''),
  fix           TEXT NOT NULL CHECK (trim(fix) <> ''),
  severity      TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium')),
  raised_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_order_finding_answer (
  id            INTEGER PRIMARY KEY,
  finding_id    INTEGER NOT NULL UNIQUE REFERENCES factory_order_finding(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  answer        TEXT NOT NULL CHECK (answer IN ('fixed', 'refused')),
  resolution    TEXT,
  recorded_at   TEXT NOT NULL,
  CHECK (answer <> 'refused' OR (resolution IS NOT NULL AND trim(resolution) <> ''))
);

-- What a worktree's setup and teardown hooks reported. resources holds the
-- identifiers the hook named — containers, volumes, ports — which is all that is
-- left of what an order allocated once its worktree is gone.
CREATE TABLE IF NOT EXISTS factory_order_environment (
  id            INTEGER PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL CHECK (phase IN ('setup', 'teardown')),
  argv          TEXT NOT NULL,
  exit_code     INTEGER,
  signal        TEXT,
  stdout        TEXT NOT NULL,
  stderr        TEXT NOT NULL,
  resources     TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_order_document (
  order_id      TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
  worker        TEXT REFERENCES factory_worker(name),
  path          TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (order_id, path)
);

CREATE TABLE IF NOT EXISTS factory_order_slice (
  id            INTEGER PRIMARY KEY,
  artifact_id   INTEGER NOT NULL REFERENCES factory_order_artifact(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL CHECK (ordinal > 0),
  title         TEXT NOT NULL CHECK (trim(title) <> ''),
  outcome       TEXT NOT NULL CHECK (trim(outcome) <> ''),
  UNIQUE (artifact_id, ordinal)
);

CREATE TABLE IF NOT EXISTS factory_order_slice_completion (
  slice_id      INTEGER PRIMARY KEY REFERENCES factory_order_slice(id) ON DELETE CASCADE,
  worker        TEXT NOT NULL REFERENCES factory_worker(name),
  completed_at  TEXT NOT NULL
);

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
--
-- No foreign key, because \`rebuild\` drops message and then writes the same ids
-- back, so a label keyed by one survives it. \`dim label\` refuses a message id
-- that is not in the table, which is where a typo is caught instead.
CREATE TABLE IF NOT EXISTS correction_label (
  message_id      TEXT PRIMARY KEY,
  label           TEXT NOT NULL CHECK (label IN ('correction','clarification','not_correction')),
  skill_name      TEXT,
  rule            TEXT,                 -- which instruction was overridden, in the owner's words
  labeled_at      TEXT NOT NULL
);

-- No source to re-read — an answer exists only in the session that made it — so
-- \`rebuild\` never clears this, as it does not clear hook_event. Grades the
-- reviewer and never the builder: measures in docs/findings.md looked like grades
-- and turned out to track what was being worked on instead.
CREATE TABLE IF NOT EXISTS finding (
  id           INTEGER PRIMARY KEY,
  repo         TEXT NOT NULL,        -- as repo_commit spells it, so a row reaches commit_file
  slice        TEXT NOT NULL,
  dimension    TEXT NOT NULL,        -- which of the reviewer's four questions raised it
  file         TEXT,                 -- relative to the checkout
  summary      TEXT NOT NULL,        -- the reviewer's words, not the builder's
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

-- The check a repository declared when sync read it. A null command is the
-- source's answer that it declared no check, not an inference from its tools.
CREATE TABLE IF NOT EXISTS repo_check (
  repo            TEXT PRIMARY KEY,
  command         TEXT
);

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
-- Never cleared by \`rebuild\`, because only the model \`dim embed\` runs can
-- produce these vectors again. No foreign key, because \`rebuild\` drops message
-- and repo_commit and then writes the same ids back, so a vector keyed by one
-- survives it. text is
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

-- One row per handoff-shaped message, rebuilt from transcript text. The message
-- is the source identity; next is stored so wake and resume do not re-parse a
-- transcript at read time.
CREATE TABLE IF NOT EXISTS factory_handoff (
  message_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  ts              TEXT NOT NULL,
  title           TEXT NOT NULL,
  next            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS factory_handoff_session_ts ON factory_handoff(session_id, ts);

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

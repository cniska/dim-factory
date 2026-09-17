# Session database — design

A local SQLite database, fed daily from Claude Code and Codex on this machine, that turns the owner's own coding sessions into evidence about how his skills behave. Personal analysis tool; not a product.

All paths below are on this machine. Line numbers refer to the file as it was on 2026-09-16; transcripts are append-only so earlier lines keep their numbers.

## 1. Why collection comes first

Claude Code deletes local transcripts after 30 days by default ("Claude Code clients store session transcripts locally in plaintext under `~/.claude/projects/` for 30 days by default to enable session resumption. Adjust the period with `cleanupPeriodDays`." — code.claude.com/docs/en/data-usage, Data retention, fetched 2026-09-16). On this machine:

- `~/.claude/settings.json` does not set `cleanupPeriodDays`; `~/.claude/.last-cleanup` reads `2026-09-08T13:27:10.947Z`.
- The oldest surviving main transcript is dated 2026-08-09; the earliest `timestamp` inside any surviving transcript is `2026-07-22T08:29:39.659Z`.
- `~/.claude/history.jsonl` (32,471 prompt lines, earliest 2026-03-04) names 694 distinct `sessionId`s; 389 of them have no transcript on disk any more. Six project slugs under `~/.claude/projects/` are empty directories: the sessions were cleaned up, the folders remain.
- `~/.claude/stats-cache.json` records `firstSessionDate: 2026-03-28` and `totalSessions: 254` as of 2026-07-25 — none of those sessions exist as transcripts today.

Codex keeps everything: 216 rollout files from 2026-02-05 onward, all still present (`~/.codex/state_5.sqlite`, `threads.rollout_path`, all 216 paths exist).

So every day without a copy running loses one more day of the Claude corpus. The first slice is therefore a raw archive of both tools' files, running on a schedule, and the immediate manual step is `"cleanupPeriodDays": 3650` in `~/.claude/settings.json` so Claude Code stops deleting. Everything else derives from the archive and can be rebuilt.

## 2. What exists on disk

### 2.1 Claude Code

**Transcripts.** `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line; subagents at `<session-id>/subagents/agent-<id>.jsonl` with a sibling `agent-<id>.meta.json`. 308 main files (1.17 GB) and 420 subagent files. Reference file for line citations below: `~/.claude/projects/-Users-christofferniska-code-skills/289e4680-8adc-4434-89f7-175277609c09.jsonl` (called **R** here; 558 lines).

Top-level `type` values across the whole corpus (728 files): `assistant` 161,371; `attachment` 127,329; `user` 101,623; `queue-operation` 22,006; `mode` 21,531; `last-prompt` 21,280; `ai-title` 20,034; `system` 14,353; `atis-latch` 12,015; `file-history-snapshot` 8,112; `file-history-delta` 5,291; `worktree-state` 3,498; `pr-link` 2,537; `permission-mode` 1,959; `custom-title` 1,105; `agent-name` 673; `relocated` 599; `cost-state` 141; `frame-link` 100; `artifact-autoreact-ledger` 52; `artifact-comment-monitor` 35; `progress` 4; `bridge-session` 3.

Shapes that matter, each verified in R:

| Fact | Where | Evidence |
|---|---|---|
| Message envelope | every `user`/`assistant` line | `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO), `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, `userType` — R:3, R:4 |
| Model per response | `assistant` line | `message.model` (`claude-opus-5`), `message.id` (`msg_…`), `message.stop_reason`, `requestId`, `effort` — R:3 |
| Token usage | `assistant` line | `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `usage.output_tokens_details.thinking_tokens` (present on 104 of 156 assistant lines in R), `usage.service_tier`, `usage.speed`, `usage.server_tool_use.{web_search_requests, web_fetch_requests}` — R:3 |
| **Usage is duplicated, and accumulates** | one API response is written as one `assistant` line per content block, each carrying the same `message.id` and a `usage` object | R has 156 assistant lines but 84 distinct `message.id`; corpus-wide 142,146 lines vs 81,620 ids. Summing per line overcounts by ~1.7x, so dedupe on `message.id` — but the lines of one response do not all carry the same figures. Usage accumulates as the response streams, and only the line with a non-null `stop_reason` holds the total: `…/-Users-christofferniska-code/e02867ae-….jsonl`, `msg_011Ce2t8c3ByESsFyYusx2yT`, is written as `{ctypes:["thinking"], output_tokens:9, stop_reason:null}` then `{ctypes:["tool_use"], output_tokens:360, stop_reason:"tool_use"}`. Keeping the first line's usage undercounts output tokens by 13% across this corpus (6,491 of 90,153 responses). Keep the largest. |
| Tool call | `assistant` line, `message.content[]` with `type:"tool_use"` | `id` (`toolu_…`), `name`, `input` — R:47 (`Skill`, `input.skill = "skill-authoring"`) |
| Tool result | `user` line, `message.content[]` with `type:"tool_result"` | `tool_use_id`, `is_error`, `content`; plus top-level `toolUseResult` and `sourceToolAssistantUUID` — R:48 |
| `toolUseResult` per tool | `user` line | Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected}` and sometimes `gitOperation` (e.g. `{"push":{"branch":"main"}}`) — R:15. Edit: `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}` — R:32. Read: `{type:"text", file:{…}}`. Skill: `{success, commandName}` — R:48. **No exit code and no duration for Bash.** |
| Typed prompt | `user` line | `promptSource` (`typed` 4,918; `queued` 2,346; `system` 550; `suggestion_accepted` 261; `sdk` 8), `origin.kind` (`human` 7,637; `task-notification` 538; `peer` 11), `permissionMode`, `promptId` — R:7 |
| User rejected a tool | `user` line | `toolDenialKind` (`user-rejected` 305; `automode-blocked` 161; `automode-unavailable` 14) and `userFeedback` (53 non-null corpus-wide) — R:80 |
| User interrupted a turn | `user` line | `interruptedMessageId` (1,377 corpus-wide) — R:330 |
| Skill body injected | `user` line with `isMeta:true` | text starts `Base directory for this skill: /Users/…/.claude/skills/<name>`; `sourceToolUseID` links to the `Skill` tool call when invoked by the model — R:49. When the user typed `/handoff` the body follows a `user` line whose content is `<command-message>handoff</command-message>\n<command-name>/handoff</command-name>` and has no `sourceToolUseID` — `…/-Users-christofferniska-code-acolyte--claude-worktrees-brand-mark/04edc781-….jsonl:2649-2650` |
| Skill attribution | `assistant` line | `attributionSkill` names the skill whose instructions the turn is running under; set on both invocation paths (R:51; brand-mark file lines 2659, 2660, 2665 after the typed `/handoff`) |
| Turn timing | `system` `subtype:"turn_duration"` | `durationMs`, `messageCount` — R:18 |
| Hooks that ran | `system` `subtype:"stop_hook_summary"` | `hookInfos[].{command,durationMs}`, `hookErrors`, `preventedContinuation` — R:17 |
| Compaction | `system` `subtype:"compact_boundary"` | `compactMetadata.{trigger, preTokens, postTokens, cumulativeDroppedTokens, durationMs}` — `…/-Users-christofferniska-code-puzzles/f7cbf185-….jsonl:2811`. **Only one in the whole corpus**; the owner resets with `/clear` (297) and `/handoff` (207) instead. |
| Session cost as computed by Claude Code | `cost-state` line | `totalCostUSD`, `modelUsage["claude-opus-5[1m]"].{inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}`, `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded/Removed`, `hasUnknownModelCost` — R:558. Present in 131 of 308 sessions. |
| Context pressure | `attachment` `attachment.type:"total_tokens_reminder"` | 57 in R — R:175 |
| Installed skills listing | `attachment` `attachment.type:"skill_listing"` | R:10 (the one-line-per-skill cost of an installed skill) |
| PR opened | `pr-link` line | `prNumber`, `prUrl`, `prRepository` — a product-line transcript, line 269 |
| Worktree | `worktree-state`, `relocated` | `worktreeSession.{worktreePath, worktreeBranch}`; `relocatedCwd` |
| Subagent linkage | `subagents/agent-<id>.meta.json` | `{agentType, description, toolUseId, spawnDepth}` — `…/1898966f-…/subagents/agent-a07d010a033dbe536.meta.json`; each subagent line also carries `agentId` and `isSidechain:true`. The parent's `Agent` tool result carries `toolUseResult.{agentId, status:"async_launched", outputFile, resolvedModel}` — `…/1898966f-….jsonl:144`. Agent types: `general-purpose` 339, `Explore` 31, `claude` 23, `Plan` 18, `fork` 3. |
| File edits tracked | `file-history-delta` | `trackingPath`, `backup.{backupFileName, version}` — R:29 |
| Two session ids | `sessionId` vs `session_id` | 274 of 308 sessions contain lines where they differ (R:3 has `sessionId` = file name, `session_id` = `56dda664-…`). Meaning not documented; the file name / `sessionId` is the key, `session_id` is stored as-is and left uninterpreted. |
| Model spread | `assistant.message.model` | `claude-opus-5` 141,524 lines; `claude-opus-4-8` 316 (all July); `claude-sonnet-5` 263; `<synthetic>` 43. **The surviving Claude corpus is effectively one model.** |

Lines of type `mode`, `ai-title`, `last-prompt`, `atis-latch`, `permission-mode`, `queue-operation` carry `sessionId` and small state and no `uuid`; they are ingested as session events, not messages.

**Other files under `~/.claude/`:**
- `history.jsonl` — `{display, pastedContents, timestamp (ms), project, sessionId}` per typed prompt (line 1). This survives cleanup; for the 389 deleted sessions it is the only remnant.
- `settings.json` — hooks configured for `PermissionRequest`, `PostToolUse` (two), `PostToolUseFailure`, `PreToolUse`, `SessionEnd`, `SessionStart` (two), `Stop`, `UserPromptSubmit`; all but one are third-party notifiers (superset, herdr) and a biome formatter.
- `stats-cache.json`, `cost-baselines/` (69 files, one number each), `telemetry/` (failed-upload event JSON), `sessions/` (process peer tokens), `file-history/`, `tasks/`, `debug/` — none add a fact the transcript lacks; not ingested.

### 2.2 Codex (codex-cli 0.154.0)

Codex stores each thread twice:

1. **Rollout JSONL**: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl` (101 files) and `~/.codex/archived_sessions/` (115 files); 1.04 GB total. Every line is `{timestamp, ordinal, type, payload}` (reference file **C** = `~/.codex/sessions/2026/09/15/rollout-2026-09-15T21-25-23-01a0a651-086e-7150-8650-cef0f4025a58.jsonl`, 2,044 lines; C:1 shows `ordinal:0`).
2. **SQLite projections**: `~/.codex/state_5.sqlite` table `threads` (216 rows: `id, rollout_path, cwd, model, reasoning_effort, tokens_used, cli_version, git_branch, git_sha, source, created_at, archived, history_mode, …`) and `thread_spawn_edges`; `~/.codex/thread_history_1.sqlite` tables `thread_turns` (11,101 rows: `thread_id, turn_id, status, started_at, completed_at, duration_ms`) and `thread_items` (87,622 rows: `item_type` ∈ agentMessage 32,446 / reasoning 20,818 / userMessage 16,794 / commandExecution 13,095 / fileChange 3,134 / mcpToolCall 506 / imageView 296 / contextCompaction 273 / webSearch 207 / …, `item_json`).

The rollout is the source of record (the SQLite files are a projection of it, `thread_history_projection_state` tracks `next_rollout_byte_offset`), and it is the only place token usage lives. Verified shapes in C:

| Fact | Where | Evidence |
|---|---|---|
| Session | `session_meta` | `payload.{id, timestamp, cwd, originator, cli_version, source, thread_source, model_provider, history_mode, git.{commit_hash, branch}}` — C:1 |
| Model, per turn | `turn_context` | `payload.{turn_id, model, effort, cwd, approval_policy, sandbox_policy, personality, collaboration_mode}` — C:6 (90 per file; the model can change between turns) |
| Token usage, per API response | `token_usage_record` | `payload.{thread_id, turn_id, response_id, usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}, turn_token_usage, thread_token_usage}` — C:14. `usage` is this response; the other two are running totals. 222 records, 222 distinct `response_id`. Also `event_msg` `token_count` with `info.last_token_usage` and `rate_limits` (C:17). **Old rollouts (Feb 2026) have no `token_usage_record`, only `token_count`** (archived rollout 2026-02-05: 0 vs 170). |
| Turn timing | `event_msg` `task_complete` | `payload.{turn_id, started_at, completed_at, duration_ms, time_to_first_token_ms}` — C:130; `turn_aborted` with `reason:"interrupted"` — C:1020 |
| Tool call | `response_item` `custom_tool_call` (`name:"exec"`, `input` is JS calling `tools.exec_command`) — C:13; `function_call` (`name:"js"`) | plus `event_msg` `item_completed` with `payload.item.type` ∈ CommandExecution / FileChange / McpToolCall / … and `started_at_ms`, `completed_at_ms` — C:8. CommandExecution item has `exit_code`, `duration`, `command`, `status`, `stdout/stderr` — the projected `thread_items` row has camel-case `exitCode`, `durationMs` (12,072 completed / 1,026 failed, none null). |
| User message | `response_item` `message` `role:"user"` `content[].input_text` | and projected `thread_items` userMessage with `content[].type` ∈ `text` 16,785 / `skill` 24 / `image`/`localImage` |
| **Skill invoked** | userMessage `content[]` `{type:"skill", name, path}` alongside the `$name` mention text | 24 corpus-wide: pr 7, land 5, search-sessions 3, agents-md 3, review 2, handoff 2, simplify 1, build 1 |
| **Skill body injected** | next `response_item` `message` `role:"user"` whose text starts `<skill>\n<name>pr</name>\n<path>/Users/…/skills/pr/SKILL.md</path>` and contains the whole SKILL.md | `~/.codex/archived_sessions/rollout-2026-08-11T19-50-26-019ff1bb-….jsonl:10` (4,088 chars) |
| Skill read by the model on its own | commandExecution `command` containing `sed -n '1,240p' …/skills/<name>/SKILL.md` | 52 build, 51 git, 48 review, 43 acolyte, 33 pr, 22 simplify, 21 debug, 17 tdd, 16 plan, 14 ship, 12 handoff … |
| Skill listing (installed) | `response_item` `message` `role:"developer"` `<skills_instructions>` with roots `r0 = ~/.agents/skills` | C:3 |
| Compaction | `compacted` line (`payload.{window_number, latest_token_usage_record, …}`) — C:1419; `contextCompaction` item | |
| Subagents | `threads.source` JSON `{"subagent":{"thread_spawn":{parent_thread_id, depth, agent_nickname, agent_role}}}`; `thread_spawn_edges` | 16 edges |
| Model spread | `threads.model` | gpt-5.2 79, gpt-5.3-codex 38, gpt-5.6-terra 14, gpt-5.6-luna 14, gpt-5.5 14, gpt-5.4-mini 14, gpt-5.6-sol 12, gpt-5.4 12, (null) 10, others ≤2 |
| Cost | — | **No cost or price field anywhere** in rollouts or the SQLite files (grep for `"cost` returns nothing). Tokens only. |

`~/.codex/history.jsonl`: `{session_id, ts (s), text}` per typed prompt, 16,951 lines, earliest 2026-02-05, 107 sessions. `~/.codex/hooks.json` configures `SessionStart`, `Stop`, `UserPromptSubmit` notifiers; the Codex docs state `Stop` and `UserPromptSubmit` are "Not currently supported" (learn.chatgpt.com/docs/hooks, fetched 2026-09-16), so two of the three do nothing.

### 2.3 Hook events available

Claude Code (code.claude.com/docs/en/hooks, fetched 2026-09-16): `SessionStart` (`source` ∈ startup/resume/clear/compact/fork; sometimes `model`), `SessionEnd` (`reason` ∈ clear/resume/logout/prompt_input_exit/other; **exit code ignored, all SessionEnd hooks share a 1.5 s budget**), `UserPromptSubmit` (`prompt`), `UserPromptExpansion` (`command_name`, `expanded_prompt`), `Stop` (`last_assistant_message`), `PreToolUse`/`PostToolUse`/`PostToolUseFailure` (`tool_name`, `tool_input`, `tool_use_id`, `tool_response` / `error_message`), `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact` (`trigger`), `PreModelSwitch`/`PostModelSwitch` (`from_model`, `to_model`), `InstructionsLoaded`, and others. Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`. Hooks run in parallel. The docs do not state that `PostToolUse.tool_response` carries an exit code or a duration; for Bash it is "the tool's output", which the transcript already has.

Codex (learn.chatgpt.com/docs/hooks, fetched 2026-09-16): `SessionStart`, `SessionEnd` ("`reason` … for now … always `other`"; timeout 1 s, max 3 s), `PreToolUse`, `PostToolUse` (`turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`), `PermissionRequest`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`. Common fields include `model`. `Stop`, `UserPromptSubmit`, `Interrupt`: not supported. Hooks enabled by default. `transcript_path` "isn't a stable interface".

### 2.4 Prior art: acolyte's transcript import

`~/code/acolyte/docs/notes/transcript-import-design.md` (status 2026-09-02) and the built, tested code in the worktree `~/code/acolyte/.claude/worktrees/transcript-import/` (branch `transcript-import`, `04045aa7`; not on `main`) already read Claude Code transcripts from this machine, for memory distillation: `src/transcript-claude-code.ts` (202 lines, test 204), `src/transcript-import.ts` (403; tests 445 + 312), `src/import-ledger.ts` (66). Verified at the source: `parseClaudeCodeTranscript` (`src/transcript-claude-code.ts:141-202`) turns a file into `TranscriptExchange {prompt, response, activity}` (`:38-43`); the ledger keys `<source>:<sourceSessionId>` (`src/import-ledger.ts:22-24`) and counts exchanges consumed; `ImportReader` lists files by mtime and reads them whole (`src/transcript-import.ts:36-39`, `:55-78`); `DEFAULT_MAX_TURNS = 25` (`src/cli-import.ts:15`); the distiller prompt's bar (`src/memory-distiller.ts:54-59`, "Some leave none … that is the right answer" `:67`), `commitScope` (`:256`), and the known-facts recall path (`:284-291`). The note's line references are off by one to eight lines after the branch's last commit; every cited claim still holds.

What that work establishes about this machine's transcripts, and what this design does with each decision:

- **List/read split** — adopted, in this shape: "list" is `stat` of the source files against `source_file` (size, mtime) for Claude and one query against `~/.codex/state_5.sqlite threads` (`id, rollout_path, cwd, updated_at`) for Codex; "read" is `tail -c +cursor` of only the files that changed. The note's scale argument (do not materialize 11,288 messages to plan a run) is the same reason `sync` never re-parses an unchanged file.
- **Head scan for the first `cwd`** — verified: line 1 of a Claude transcript is never a message (`mode` 267, `custom-title` 17, `last-prompt` 15, `ai-title` 8, `queue-operation` 1 across the 308 main files); the first line carrying `cwd` is line 3 in 182 files, 4 in 67, 5 in 48, up to line 9. `session.cwd` and `started_at` are taken from that first record. Ingestion reads the whole file anyway, so no separate head scan is needed here.
- **Normalized boundary shape with per-source parsers** — adopted as the shared tables plus `extra` JSON (§5). The difference is what is normalized: acolyte keeps prompt, response and a tool-activity digest and deliberately drops everything else — sidechains (`transcript-claude-code.ts:165`), `isMeta` bodies (`:181`), `<command-name>` prompts as harness noise (`:64-79`), and it never reads `usage`, `model`, `attributionSkill`, `promptSource`, `toolUseResult` or timestamps per message. Those dropped fields are most of what §3 needs, and the `<command-name>` lines it discards are the user-typed skill invocation signal.
- **Ledger keyed by stable source id** — adopted: Claude file basename = `sessionId`; Codex thread id from `session_meta.id` (= the rollout filename suffix). The cursor here is a byte offset rather than an exchange count because this ingester stores every line, not turns.
- **Yield scoring rejected** — agreed, for a simpler reason: this database spends no model calls on ingest, so there is nothing to save by filtering. Every message is stored; the only exclusion (tool results, file contents, thinking) is a privacy decision about what the DB carries as text, not a judgment about which turns matter.
- **Staleness budget** — not applicable: nothing here is gated on repository movement, and an analysis corpus wants the stale sessions too.
- **Format facts the parser encodes, checked against disk**: `type`, `message.role`, `message.content` string-or-blocks, `cwd`, `sessionId`, `timestamp`, `isMeta`, `isSidechain` — all present (§2.1). Tool path argument: `file_path` is what Edit/Write/Read carry; `notebook_path` occurs in zero of the 308 main transcripts on this machine. The harness-prefix list (`:64-75`) is accurate but redundant here: `promptSource` and `origin.kind` (R:7) already separate a typed prompt from a harness-generated one, and `<command-name>` is kept as a signal, not dropped as noise.
- **Sidechain link back to the parent**: yes — every subagent line carries `agentId` and the parent's `sessionId` (`…/1898966f-…/subagents/agent-a07d010a033dbe536.jsonl:1`), the `meta.json` carries the spawning `toolUseId`, and the parent's `Agent` tool result carries `toolUseResult.agentId` (`…/1898966f-….jsonl:144`). The parser's `if (record.isSidechain) continue` (`:165`) drops exactly the rows that count subagent spawns for §9.9.
- **Exchange shape vs event shape**: event rows. Every question in §3 keys on a single record — a `tool_use` block, a usage object, a `turn_duration` line, a skill body — with its own timestamp and model; an exchange digest has none of those. `message`/`usage`/`tool_call`/`turn` are one row per record; an exchange is a view (`prompt → next end_turn`) if ever wanted.

**Stale against today's disk:**
- "codex appears abandoned … 17 of 35 sessions 200+ commits behind": no longer true. Codex has 216 threads (35 when measured), with 113 created in April 2026, 16 in July, 19 in August, 10 in September, and September's `thread_items` count (13,831) is the highest month since March. Codex has equal standing in this design on the evidence, not by policy.
- "Same for the codex `response_item` mapping" (schema unverified): the Codex schema is verified in §2.2. Two facts the note could not know: Codex now runs `history_mode: paginated` with a SQLite projection (`thread_history_1.sqlite`) beside the rollout, and per-response token usage (`token_usage_record`) exists only in rollouts written from roughly August 2026 on.
- The note assumes transcripts persist; the 30-day `cleanupPeriodDays` deletion (§1) means acolyte's own `--since` backlog beyond 30 days is gone too.

**Shared parsers or independent?** Independent, though both projects are now on the same stack (§6), because the two parsers want different things from the same bytes. `transcript-claude-code.ts` imports `./log`, `./task-activity` and `./tool-contract` (`:2-4`), so reusing it carries a port of those modules; and its zod schema (`:25-33`) exists to discard exactly the fields this design keeps — `usage`, `model`, `attributionSkill`, `promptSource`, `toolUseResult`, sidechains — so sharing would mean growing acolyte's parser to a second product's requirements. The cost stated plainly: two codebases track the Claude Code JSONL dialect and, once acolyte builds a Codex source, the rollout dialect too; when either tool renames a field, both break and both are fixed separately, and the two disagree in edge cases (acolyte treats a `<command-name>` prompt as noise; this treats it as a load). What makes the duplication cheap to live with is that the sources persist and a format change is one parser plus `dim rebuild`.

What acolyte does supply is the shape: `bun:sqlite` opened with WAL and typed prepared statements, a `close()` that checkpoints, and an XDG-aware `dataDir()` read from an injected env so a test can point a whole run at a scratch directory (`src/trace-store.ts:135-175`, `src/paths.ts:29-31`).

## 3. Questions the database answers

Ordered by what the owner can act on soonest. Each names the signal it rests on; §9 lists what it cannot answer.

1. **Where does loaded-skill context go?** Per skill: how many times its body was loaded, its size at each load, and the number of API calls that followed in the same session (every one of which re-reads the body from cache). Signal: `skill_load.body_chars` × subsequent `usage` rows. Not a deletion ranking; a list of where an over-instruction audit pays.
2. **Which skills fire, by which path, in which tool?** Model-chosen (`Skill` tool / `$name`), user-typed (`/name`), or read ad hoc by the model (Codex `sed …SKILL.md`). Skills that never appear are reported as a fact, not a finding.
3. **Where do the user's corrections land?** Tool rejections with feedback, interrupted turns, and short negating prompts, joined to the skill attributed to the turn they interrupt and to the model. A reading list, ranked by count per skill.
4. **Routing evidence for the eval harness.** Real prompts followed by a model-chosen skill (positives), prompts where no skill fired but the user typed `/skill` next (misses), and prompts where the model picked X and the user then invoked Y (wrong skill).
5. **Where do sessions burn tokens?** Per session/model: input, cache read, cache write, output, thinking; the token curve across turns; compaction and `/clear` points.
6. **Which tools dominate, and the read-to-edit ratio.** Per project and model: counts of Read/Edit/Write/Bash (Claude) and commandExecution/fileChange (Codex); the same file edited twice within a session (redo proxy).
7. **Does work land?** `git commit` in Bash commands (2,715 corpus-wide) and `git revert`/`reset --hard`/`restore` (253); `pr-link` lines; Codex `commandExecution` commands. Counted, never attributed to a skill as cause.
8. **How long do sessions and turns run?** Turn `durationMs`, session wall clock, `total_tokens_reminder` count, time to first `/handoff`.
9. **What follows what?** Skill-load sequences per session and per project-day, compared to spec → plan → build → review → ship.
10. **Everything above, sliced by model.** Every message, usage row, tool call and turn carries the model that produced it; every named query takes `--model`.

## 4. Storage and privacy

- **Location**: `~/.local/share/dim-factory/` containing `sessions.db`, `spool/` (hook events) and the lock. Home-directory path, `chmod 700`, never inside a repository; the collector's own repo (`~/code/dim-factory`) contains code and schema only, and `sessions.db` is not a path any repo tracks.
- **Pointer, not archive.** Structure plus a pointer into the original files keeps the database small and content-free. That turns on the sources surviving, and they now do: `~/.claude/settings.json` sets `"cleanupPeriodDays": 3650`, so Claude Code no longer prunes (§1 describes the 30-day default that made an archive necessary, and the 389 sessions already lost to it — those are gone either way), and Codex has never pruned. Records are addressable stably in both formats: a Claude line by `(session_id, line_number)` in an append-only file (Claude Code's own later writes — `file-history-delta`, `compact_boundary`, `cost-state` — are appended lines, never rewrites), a Codex line by `(thread_id, ordinal)` (C:1 `ordinal:0`). Every `message` and `tool_call` row carries `src_file` and `src_line`, so a question needing the full record — a tool result, a diff — re-reads one line from the source by locator. A schema change is `dim rebuild`: drop the tables and re-read the files.
- **Files move; the cursor follows the session, not the path.** Codex archives a rollout by moving it to `archived_sessions/` (115 today), and the ingestion cursor is keyed by `(session_id, kind)` so the moved file resumes where it stopped. Keying on the path instead would re-read the file from byte zero and append every assistant message's text a second time. `source_file.path` is updated in place and `message.src_file` follows it through `ON UPDATE CASCADE`, so locators stay valid across the move.
- **Cost of not archiving**: if either tool changes its retention default back, or a file is deleted by hand, what it held is lost beyond what the database already extracted. The database keeps structure and prompt text, never tool results, file contents or thinking — so those are the parts that would not survive.
- **What the DB stores as text**: user prompts (typed/queued/human origin), assistant text, `userFeedback`, skill bodies' hash and size (not the body), Bash command strings (needed for commit/verify detection), file paths of edits. **Not stored**: tool results, file contents, `originalFile`/`structuredPatch`, `thinking` blocks, attachments, MCP results, stdout/stderr. Those stay in the source files only, reachable by `src_file`/`src_line`.
- **Privacy consequence, stated plainly**: setting `cleanupPeriodDays` to 3650 is what removes the 30-day expiry that limited exposure, and it does that to `~/.claude/projects/` itself, not to anything this repo writes. That is the price of having a corpus at all. The database is the narrower surface the read path touches: prompts and assistant text, never tool results, file contents or stdout. Exclude `~/.local/share/dim-factory/` from cloud sync tools; Time Machine is local and encrypted with FileVault, so it can stay.

## 5. Schema

Both tools land in the same tables; `tool` is `'claude'` or `'codex'`. Tool-specific detail rides in `extra` JSON columns rather than tool-specific tables, so a query never needs a `UNION`. Times are ISO-8601 UTC text (SQLite compares them correctly).

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per archived file; the incremental cursor for ingestion.
CREATE TABLE source_file (
  path            TEXT PRIMARY KEY,     -- absolute path of the source file
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  kind            TEXT NOT NULL CHECK (kind IN ('transcript','subagent','history')),
  session_id      TEXT,
  origin_path     TEXT NOT NULL,        -- where it was copied from
  bytes_ingested  INTEGER NOT NULL DEFAULT 0,
  lines_ingested  INTEGER NOT NULL DEFAULT 0,
  origin_mtime    TEXT,
  ingested_at     TEXT
);

CREATE TABLE session (
  id              TEXT PRIMARY KEY,     -- Claude sessionId / Codex thread id
  tool            TEXT NOT NULL,
  parent_id       TEXT REFERENCES session(id),   -- subagent -> parent
  agent_type      TEXT,                 -- Claude meta.agentType / Codex agent_role
  cwd             TEXT,
  project         TEXT,                 -- cwd with .claude/worktrees/<x> stripped
  git_branch      TEXT,
  cli_version     TEXT,
  entrypoint      TEXT,                 -- Claude entrypoint / Codex originator
  started_at      TEXT,                 -- first message timestamp
  last_seen_at    TEXT,                 -- last message timestamp (grows while live)
  ended_at        TEXT,                 -- from SessionEnd hook only
  end_reason      TEXT,                 -- Claude: clear|resume|logout|prompt_input_exit|other; Codex: other
  first_model     TEXT,
  last_model      TEXT,
  title           TEXT,                 -- ai-title / custom-title / threads.title
  extra           TEXT                  -- JSON: Claude session_id alias, Codex source/sandbox/approval
);
CREATE INDEX session_project ON session(project, started_at);

-- One row per user or assistant message. Claude: one row per message.id
-- (content-block lines collapsed). Codex: one row per response_item message.
CREATE TABLE message (
  id              TEXT PRIMARY KEY,     -- Claude message.id (assistant) / uuid (user); Codex item id
  session_id      TEXT NOT NULL REFERENCES session(id),
  ts              TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  model           TEXT,                 -- assistant: message.model / turn_context.model
  turn_id         TEXT,                 -- Codex turn_id; Claude promptId
  prompt_source   TEXT,                 -- Claude promptSource; Codex 'typed' for userMessage text
  origin_kind     TEXT,                 -- Claude origin.kind
  is_meta         INTEGER NOT NULL DEFAULT 0,
  is_skill_body   INTEGER NOT NULL DEFAULT 0,
  attribution_skill TEXT,               -- Claude only
  stop_reason     TEXT,
  interrupted_message_id TEXT,          -- Claude interruptedMessageId
  denial_kind     TEXT,                 -- Claude toolDenialKind
  user_feedback   TEXT,                 -- Claude userFeedback
  text            TEXT,                 -- visible text only; never tool results
  text_chars      INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path),
  src_line        INTEGER NOT NULL,     -- Claude line number / Codex ordinal; first line of the record
  extra           TEXT
);
CREATE INDEX message_session_ts ON message(session_id, ts);
CREATE INDEX message_attr ON message(attribution_skill);

-- One row per API response. The only table token sums come from.
CREATE TABLE usage (
  response_id     TEXT PRIMARY KEY,     -- Claude message.id / Codex response_id
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,   -- Claude cache_creation_input_tokens / Codex cache_write_input_tokens
  cache_write_1h_tokens INTEGER,        -- Claude cache_creation.ephemeral_1h_input_tokens
  output_tokens   INTEGER NOT NULL,
  reasoning_tokens INTEGER,             -- Claude thinking_tokens / Codex reasoning_output_tokens
  attribution_skill TEXT,
  extra           TEXT                  -- service_tier, speed, server_tool_use, rate_limits
);
CREATE INDEX usage_session ON usage(session_id, ts);
CREATE INDEX usage_model ON usage(model);

CREATE TABLE tool_call (
  id              TEXT PRIMARY KEY,     -- toolu_… / call_id / exec-… item id
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  model           TEXT,
  attribution_skill TEXT,
  ts_call         TEXT NOT NULL,
  ts_result       TEXT,
  tool_name       TEXT NOT NULL,        -- Claude name; Codex 'exec'|'js'|'mcp'|'fileChange'|…
  skill_name      TEXT,                 -- Skill tool input.skill
  file_path       TEXT,                 -- Edit/Write/Read input.file_path; Codex fileChange path
  command         TEXT,                 -- Bash input.command; Codex command string
  is_error        INTEGER,
  interrupted     INTEGER,
  denial_kind     TEXT,
  exit_code       INTEGER,              -- Codex only (Claude records none)
  duration_ms     INTEGER,              -- Codex durationMs; Claude ts_result - ts_call
  git_operation   TEXT,                 -- Claude toolUseResult.gitOperation JSON
  result_bytes    INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path),
  src_line_call   INTEGER NOT NULL,
  src_line_result INTEGER,              -- where the result (stdout, diff) can be re-read from the source file
  extra           TEXT
);
CREATE INDEX tool_call_session ON tool_call(session_id, ts_call);
CREATE INDEX tool_call_name ON tool_call(tool_name);
CREATE INDEX tool_call_file ON tool_call(file_path);

-- Every time a skill's body entered context.
CREATE TABLE skill_load (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),  -- the body message
  ts              TEXT NOT NULL,
  model           TEXT,
  skill_name      TEXT NOT NULL,
  how             TEXT NOT NULL CHECK (how IN ('model','user','read')),
      -- model: Skill tool / Codex model-chosen; user: typed /name or $name; read: Codex sed/cat of SKILL.md
  body_chars      INTEGER,
  body_sha256     TEXT,                 -- sha256 of the body with wrapper and frontmatter stripped
  skill_version_commit TEXT,            -- skill_version.commit whose body_sha256 matches; NULL = dirty tree
  skill_path      TEXT,
  UNIQUE (session_id, message_id, skill_name)
);
CREATE INDEX skill_load_name ON skill_load(skill_name, ts);

-- Every committed version of every SKILL.md in the skills repo (from git log -p).
CREATE TABLE skill_version (
  skill_name      TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  body_chars      INTEGER NOT NULL,
  PRIMARY KEY (skill_name, commit_sha)
);
CREATE INDEX skill_version_hash ON skill_version(body_sha256);

CREATE TABLE turn (
  session_id      TEXT NOT NULL REFERENCES session(id),
  turn_id         TEXT NOT NULL,        -- Codex turn_id; Claude turn_duration uuid
  ts_start        TEXT,
  ts_end          TEXT NOT NULL,
  duration_ms     INTEGER,
  message_count   INTEGER,              -- Claude messageCount
  status          TEXT,                 -- Codex completed|failed|interrupted; Claude 'completed'
  model           TEXT,
  time_to_first_token_ms INTEGER,       -- Codex only
  PRIMARY KEY (session_id, turn_id)
);

-- Drained from the hook spool. No foreign key to session, and never cleared by
-- a rebuild: see §7.
CREATE TABLE hook_event (
  id          INTEGER PRIMARY KEY,
  tool        TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  session_id  TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('session_start','session_end')),
  ts          TEXT NOT NULL,        -- from the spool filename, which the hook writes
  source      TEXT,                 -- SessionStart: startup|resume|clear|compact|fork
  reason      TEXT,                 -- SessionEnd: clear|resume|logout|prompt_input_exit|other
  model       TEXT,
  cwd         TEXT,
  payload     TEXT NOT NULL,        -- the hook's stdin, verbatim
  UNIQUE (session_id, event, ts)
);

-- Everything else worth keeping, one row per occurrence.
CREATE TABLE session_event (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  ts              TEXT,
  kind            TEXT NOT NULL,
      -- compact | clear | slash_command | pr_link | worktree | relocated | title
      -- | tokens_reminder | cost_state | hook_session_start | hook_session_end
      -- | queue_op | mode | permission_mode | rate_limits
  detail          TEXT,                 -- JSON
  UNIQUE (session_id, kind, ts, detail)
);
CREATE INDEX session_event_kind ON session_event(kind, ts);

-- Cost as reported by the tool, never computed here.
CREATE TABLE session_cost_reported (
  session_id      TEXT PRIMARY KEY REFERENCES session(id),
  reported_by     TEXT NOT NULL,        -- 'claude-code cost-state'
  total_cost_usd  REAL,
  model_usage     TEXT NOT NULL,        -- JSON as written
  has_unknown_model_cost INTEGER,
  ts              TEXT
);

-- Prompts whose transcript no longer exists (from history.jsonl).
CREATE TABLE orphan_prompt (
  tool            TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  ts              TEXT NOT NULL,
  project         TEXT,
  text            TEXT,
  PRIMARY KEY (tool, session_id, ts, text)
);

-- Human labels on candidate corrections; the only table the read path writes.
CREATE TABLE correction_label (
  message_id      TEXT PRIMARY KEY REFERENCES message(id),
  label           TEXT NOT NULL CHECK (label IN ('correction','clarification','not_correction')),
  skill_name      TEXT,
  rule            TEXT,                 -- free text: which instruction was overridden
  labeled_at      TEXT NOT NULL
);
```

Derived views (created by `schema.sql`, cheap to change):

- `v_skill_context` — per `skill_name`, `body_sha256`: loads, avg `body_chars`, and `SUM(calls_after_load)` where `calls_after_load` = count of `usage` rows in the same session after the load's `ts`. That product is the body's re-read count, the honest unit of context cost. Token estimate is not stored; chars are.
- `v_correction_candidate` — `message` rows with `denial_kind='user-rejected'`, or `interrupted_message_id IS NOT NULL`, or (`role='user' AND prompt_source IN ('typed','queued') AND text_chars < 200 AND text matches a negation lexicon`), joined to the last `attribution_skill` and `model` before them.
- `v_routing_case` — each human prompt with: the skill the model called in the next assistant message (if any), and the skill the user invoked within the next two human prompts (if any).
- `v_session_summary` — per session: tool, project, models, turns, tokens by class, tool counts, commits, reverts, skill loads, corrections, end reason.

Normalization line: `message`, `usage`, `tool_call`, `turn`, `session_event` are one-to-one with things in the raw files and are rebuilt by re-ingesting. `skill_load` is derived but stored (needs cross-line joins that are awkward in views). Views hold every judgment call so they can change without re-ingesting.

Model identity is a column on `message`, `usage`, `tool_call`, `turn`, `skill_load`, and `session.first_model/last_model`. Claude's `cost-state` uses `claude-opus-5[1m]` while `message.model` uses `claude-opus-5`; both kept verbatim, views strip the `[…]` suffix into `model_family`.

## 6. Ingestion

**Boundary: no network, no credential, no per-token cost, and no model reading a transcript.** Ingestion is file copy, jq parsing and SQL inserts; backfilling seven months costs disk and CPU only. The one model here is the local embedder `dim embed` runs over distilled text, on weights that sit on disk after a single download — it reads no transcript and no raw turn. There is no pre-filter, scoring or relevance judgment at ingest — with no downstream scorer to defer to, storing everything and deciding at read time is the only policy that is not irreversible. A model enters only when the owner asks a question, and then it reads query output (aggregates, excerpts already in the DB), never transcripts. Skill detection is string and field matching on records that exist (§9.1); correction detection is deliberately left as candidate narrowing plus human or deliberately invoked judgment (§9.3).

**Implementation**: Bun + TypeScript with `bun:sqlite`, matching acolyte's stack. The owner works in TypeScript; bash + jq would have been inherited from `cniska/skills`, whose tooling convention does not govern this repo. A first cut in bash + jq + sqlite3 was written and discarded: half of it was encoding work that the language removes outright — `sqlite3`'s ascii-mode `.import` drops a leading or trailing empty field, so every row needed sentinel columns; an awk splitter fanned one jq stream into per-table files; and jq cannot carry parser state across a chunk boundary. Bound parameters and `JSON.parse` need none of it. On this corpus the TypeScript ingester backfills in 20 seconds against the shell version's 4 minutes. The runtime is the cost: a collector on a schedule now depends on Bun being installed, pinned in `mise.toml`.

Each line is one JSON object, parsed one at a time; a chunk is read by byte range, never the whole file at once when resuming. Per-tool parsers (`parse-claude.ts`, `parse-codex.ts`) turn lines into the rows in §5 and know nothing about the database; `ingest.ts` holds every upsert and knows nothing about either format.

**Incremental and idempotent**:
- Per file, `source_file.bytes_ingested` is the cursor; the ingester `tail -c +N` from there. Both formats only append. If the origin is shorter than the cursor, the file is re-ingested from zero after deleting its rows (`DELETE … WHERE session_id = ?` is cheap) and the anomaly is logged.
- Natural keys make re-runs no-ops: Claude `message.id` for assistant rows, `uuid` for user rows, `toolu_` ids, `response_id`; Codex item ids, `response_id`, `(thread_id, turn_id)`. Lines without ids (`mode`, `ai-title`, …) go to `session_event` with a `UNIQUE(session_id, kind, ts, detail)` key.
- Assistant content-block lines sharing a `message.id` collapse: text is concatenated in file order, usage is written once.
- A live session ingests cleanly: `session.last_seen_at` advances, `ended_at` stays null until the hook spool says otherwise.

**Trigger**: a `launchd` agent (`~/Library/LaunchAgents/com.cniska.dim-factory.plist`, `StartInterval` 900), written by `dim install-agent`, runs `dim sync`: drain the spool → read changed files → derive session end from the spool. Hooks do not write the DB (§7). A manual `dim sync` does the same on demand; `dim rebuild` is `sync` with every cursor reset.

Two things the agent's environment forces. The plist names `bun` by absolute path, because launchd starts an agent with almost no environment and a PATH shim is not there when it runs; it resolves the `bun` on PATH rather than the running executable, since that can be a version-pinned path that the next upgrade deletes. And the lock under `~/.local/share/dim-factory/lock` records the holder's pid: `mkdir` is the atomic primitive available (macOS ships no `flock`), but a run that is killed leaves the directory behind, and without the pid check the agent would fail every fifteen minutes from then on.

**Backfill reach at first run**: Claude transcripts 2026-07-22 → today (308 sessions, 420 subagents); Claude `history.jsonl` prompts 2026-03-04 → today (389 sessions as `orphan_prompt` only); Codex rollouts 2026-02-05 → today (216 threads, all of them); Codex `history.jsonl` 2026-02-05 → today. Codex token usage per response exists only from the rollouts that carry `token_usage_record` (September 2026 files do; February files carry `token_count` running totals only — those are ingested into `session_event kind='rate_limits'`/totals, not `usage`).

## 7. Hook-based collection

**Which hooks, and why each earns its cost.**

| Tool | Event | What it records that the transcript lacks | Cost |
|---|---|---|---|
| Claude | `SessionEnd` | `reason` (clear/resume/logout/prompt_input_exit/other) and the end timestamp. The transcript has no end marker; today "abandoned" is indistinguishable from "still open". | one `cat > file`, inside the shared 1.5 s budget |
| Claude | `SessionStart` | `source` (startup/resume/clear/compact/fork) and `model` when present — whether a session is a resume. The transcript's `session_id`/`sessionId` mismatch (274 sessions) is undocumented; this is the documented signal. | one file write at start, not in a tool path |
| Codex | `SessionEnd` | End timestamp and `model`. `reason` is always `other`, so how it ended is not captured. | one file write, 1 s limit |
| Codex | `SessionStart` | `source`, `model` at start | one file write |

Not installed, and why: `Stop` duplicates `turn_duration` lines (Claude) and is unsupported (Codex). `PostToolUse` fires on every tool call; the transcript already has input, result, and both timestamps, and the docs do not promise an exit code in `tool_response`, so it would add wall-clock precision only, at a per-call cost. `UserPromptSubmit` duplicates `promptSource:"typed"` lines. `PreCompact`/`PostCompact`: compaction happened once in the corpus.

**Budget and failure mode**: each hook is `cat > "$SPOOL/$(date +%s%N)-$$.json" 2>/dev/null; exit 0`. No jq, no sqlite, no network; sub-millisecond; always exits 0; if the spool directory is missing it fails silently and the session is unaffected. SessionEnd hooks on Claude ignore exit codes anyway.

**Concurrency**: hooks never open the database. One file per event (`O_CREAT` of a unique name) is atomic on APFS; the scheduled `sync` moves spool files into `session_event` and `session.ended_at/end_reason` under the `flock`. Concurrent sessions therefore never contend on `sessions.db`; only `sync` writes it, one process at a time, in WAL mode so the read path can query during a sync.

**One canonical source per column**: the spool drains into `hook_event`, its own table, and `session.ended_at`/`end_reason` are derived from it on every sync. Everything else comes from transcripts only, and no column is written by both paths.

`hook_event` is the one table `dim rebuild` does not clear, and the reason is the whole point of installing the hooks: every other table is re-read from files that persist, while a session that ended before its hook was installed can never be told apart from one still open. It carries no foreign key to `session` for the same reason — a hook fires for sessions whose transcript has not been read yet, or never will be — so an event that arrives early waits in the table and lands on the session the next time one appears. A spool file that cannot be placed is moved to `spool/unreadable/` rather than deleted, because it is the only copy.

**Codex asymmetry**: Codex hooks give no `Stop`, no `UserPromptSubmit`, and a constant `SessionEnd.reason`. Interrupts are in the rollout (`turn_aborted reason:"interrupted"`, `thread_turns.status`), so "abandoned mid-turn" is visible; "closed the window vs. typed exit" is not. Codex also has no `attributionSkill`, so tokens cannot be attributed to a skill within a Codex session — only "session loaded skill X at time T". Those are the two places Codex analysis is coarser than Claude's; everything in §3 except per-turn skill attribution holds for both.

## 8. Token and cost accounting

- **Tokens** come from `usage` only: Claude `message.usage` deduplicated on `message.id`; Codex `token_usage_record.usage` per `response_id`. Both record input, cached-read, cache-write, output; Claude adds the 5m/1h cache-write split and `thinking_tokens`, Codex adds `reasoning_output_tokens`. Both are stored; no cross-tool "total" pretends they are the same currency.
- **Cost** is stored only where the tool computed it: Claude's `cost-state.totalCostUSD` and per-model `costUSD` (131 of 308 sessions have one). Codex reports none. The database does not carry prices and derives no dollar figures; a `q cost` query returns Claude's reported USD where present and "not reported" otherwise.

## 9. Measuring the skills — what holds and what does not

### 9.1 Invocation (sound)
Three `how` values, all verified on disk (§2): `model` (Claude `Skill` tool call, 644 corpus-wide — git 95, review 78, handoff 75, pr 46, simplify 43, build 43, spec 42, agents-md 36 …; Codex `$name` chosen by the model is not distinguishable from user-typed and is recorded as `user`), `user` (Claude `<command-name>/name</command-name>`, e.g. `/handoff` 207, `/pr` 13, `/review` 8, `/simplify` 7; Codex userMessage `content[].type="skill"`, 24), `read` (Codex model running `sed …/skills/<name>/SKILL.md`, hundreds — the dominant Codex path). The installed listing (`skill_listing` attachment; Codex `<skills_instructions>`) is loaded-as-context and is recorded once per session as a `session_event`, not as a load.

### 9.2 Context cost (sound, in chars)
`skill_load.body_chars` is the injected body's length (Claude: 238 handoff loads averaging 5,081 chars; 86 review at 8,195; 36 agents-md at 11,347; and two loads of the `claude-api` plugin skill at 388,970 chars each). Multiplied by API calls after the load in that session, it is the number of times that text was re-read from cache. It is reported in chars; a token conversion is an estimate and is labeled so if ever shown. Share of a session's input: `body_chars × calls_after` versus `SUM(cache_read_tokens + input_tokens) × 4` is an estimate on both sides and is not a stored metric.

### 9.3 Correction signal (mechanical part sound; the rest is unresolved by design)
Mechanical and reliable, because the tool recorded the act: `toolDenialKind='user-rejected'` with `userFeedback` (305 / 53 with text, R:80) and `interruptedMessageId` (1,377, R:330) on Claude; `turn_aborted reason:"interrupted"` and `thread_turns.status='interrupted'` (844 of 11,101) on Codex. These are the user physically stopping the agent and are stored as fields on `message`/`turn`.

Whether a typed prompt *tells the agent it was wrong* is semantic, and no deterministic rule detects it honestly. The design therefore does not store a classification. What it does: store every human prompt with its text, skill attribution and model; let `q corrections` narrow cheaply at read time (short prompts, prompts following an `end_turn` within seconds, an optional caller-supplied regex — a rough one over 8,083 human prompts returns 150 rows, of which the sample reads about half as corrections — "no it was 5 days ago you overwrote my .env", "i said MINMAL SETUP" — and half as clarifications — "no webhooks?"); and leave the judgment to the owner (`correction_label`, written by `q label`) or to a model he invokes deliberately on that narrowed set, reading the excerpts the query returned. Model cost is then bounded by his curiosity, not by corpus size, and nothing in the collection path makes the call. The per-skill "corrections" figure reports the mechanical signals and labeled rows; it never counts unlabeled candidates as corrections.

Clustering corrections on a *rule* inside a skill is not automatable from transcripts: nothing in the data names which sentence of the SKILL.md the model was following. The reading list (skill → candidate corrections with 200-char excerpts, session id, timestamp) is what the DB provides; the rule is what the owner writes in `correction_label.rule`.

### 9.4 Following versus ignoring a skill (not measurable here)
The transcript does not record which instruction the model acted on. Structural compliance (a handoff has the mandated sections; a review names severities) is checkable only per skill with hand-written deterministic checks — exactly what `evals/run.sh` does with `det_re`. That belongs in the eval harness with fixed fixtures, not here. The DB's contribution is the list of real sessions in which a skill loaded, so eval fixtures can be drawn from real inputs.

### 9.5 Effectiveness and outcome comparisons (weak signal only)
Commits, reverts, turn counts, tokens, re-edits of the same file, and handoff-vs-abandon are all computed per session and joinable to skill loads. None of them is an effect of the skill: a skill loads *because* the task is of a certain kind, so sessions with `review` loaded will differ from sessions without it regardless of what `review` says. What the design does with these numbers:

- Sound: **within one skill across its versions** (`body_sha256`), same project, same tool, same model — before/after a skill edit. Still confounded by task, but the population is the same kind of work.
- Sound as a prompt for a human look: a skill whose sessions show a high labeled-correction rate.
- Not sound, and not built: skill-loaded vs not-loaded outcome comparison; long-skill vs short-skill outcome correlation (length is confounded with task complexity by construction — he wrote the longest skills for the hardest workflows); any ranking of skills by outcome.

### 9.6 Cross-model comparison (not supportable from this corpus)
The surviving Claude corpus is `claude-opus-5` (141,524 assistant lines) with 316 lines of `claude-opus-4-8` from July: there is no before/after to compare. Codex spans gpt-5.2 → gpt-5.6 variants across February–September, but across those months the projects, the skills' text and the owner's habits all changed. Model is on every row so that a future transition is *observable* — same skill version (`body_sha256`), same project, sessions on either side of the model switch — but even then the answer is "look here", not "the skill got worse". A conclusion would need the same task run under both models with the skill held fixed, which is the eval harness with `--baseline`, run twice.

### 9.7 Feeding the trigger evals (sound)
`v_routing_case` yields, per human prompt: text (≤ 300 chars), session, tool, model, `skill_called_next` (model's choice in the next assistant message, or null), `skill_user_invoked_next` (a `/name` or `$name` in the following two human prompts, or null). `dim export routing-cases --skill X` writes JSONL of: positives (`skill_called_next = X`), misses (`skill_called_next IS NULL AND skill_user_invoked_next = X`), and wrong-skill (`skill_called_next = Y AND skill_user_invoked_next = X`). Prompts that are themselves a slash command are excluded (they carry no routing information). This is the export the eval design consumes; the DB does not judge which cases are good tests.

### 9.8 Workflow shape (sound as description)
`skill_load` ordered by `ts` within a session, and within a project-day across sessions (handoff resets split one piece of work over several session ids: 297 `/clear`, 207 `/handoff`). Reported as transition counts (A → B) and as the fraction of build loads preceded by a plan/spec load and followed by a review load in the same project within 24 h. Time leaks: turns over N minutes, gaps between a tool result and the next user prompt, sessions with `total_tokens_reminder` before any commit.

### 9.9 Retrospective: skill version in effect at each load (weak signal, cheap to compute)

**The join.** The skills repo has one commit per change to each `skills/<name>/SKILL.md` (`git log --format='%H %aI' -- skills/<name>/SKILL.md`), and `~/.agents/skills/<name>` is a symlink into that working tree (`~/.agents/skills/agents-md -> ~/code/skills/skills/agents-md`), so a load at time T ran the text of the last commit at or before T — unless the working tree was dirty. `skill_load.body_sha256` settles that: Claude injects the body without frontmatter after a `Base directory for this skill:` line (R:49), Codex injects frontmatter and body inside `<skill>…</skill>` (archived rollout 019ff1bb-… line 10); the ingester strips both wrappers and the frontmatter, hashes the body, and a `skill_version` table (`skill_name, commit, committed_at, body_sha256`) built by `dim skill-versions` from `git log -p` gives the exact match or "no committed version matches — dirty tree". `skill_load.skill_version_commit` is then a plain column, and every query in §10 can group by it. No model, no judgment: hash equality and a date interval.

**What the corpus holds per skill** (Claude body loads / Codex threads that read the file, as of 2026-09-16; Claude reaches back to 2026-07-22, Codex to 2026-02-05): handoff 238 / 12; git 95 / 51; review 86 (85 sessions) / 28; pr 57 / 33; simplify 49 / 22; build 44 / 52; spec 43 / —; agents-md 36 / —; plan 10 / 16; debug 1 / 21; tdd 0 / 17; ship 3 / 14; explain-diff, design, deprecation, issue, skill-test: ≤ 1 each. Versions in the window: `review` changed on 2026-08-05 (`f44f55f`) and 2026-09-04 (`6587b24`); `ship` has a single commit (`bca17fe`, 2026-07-23); `correctness-review` and `style-review` last changed before the corpus begins.

**Case 1 — "fan out on more than 3 files" in `review:37,46`, `correctness-review:45`, `style-review:61`.** The rule predates every transcript on disk (`git log -S'more than 3 files'` finds only the 2026-07-10 restructure commit `6813bf5`, which carried it in), so there is no "before" arm — every review session in the corpus ran under it. What is directly observable: per review session, `Agent` tool calls with `attribution_skill='review'` (85 Claude sessions, 120 spawns; per session 0–9, 20 sessions with none, median 1, eight sessions ≥ 4, one with 9 — `e398a4a1`, 2026-09-04) against the diff size, which the DB does not hold as a column but the raw archive does: the first `git diff --stat`/`--name-only` Bash result under review attribution, re-read by `src_line_result`, gives the file count. A `review_scope(session_id, files_in_diff, spawns, model, skill_version_commit)` derivation answers "how many spawns per file count" today, and the two `review` versions inside the window (08-05, 09-04) split the 85 sessions into arms — for *those* edits, not for the fan-out rule. Codex: 28 threads read `review/SKILL.md`; subagent items (`collabAgentToolCall` + `subAgentActivity`) total 42 across the whole Codex corpus, so spawn counting works there too but the sample is thin.

**Case 2 — `ship` says "warn, don't block" for quality checks (`ship:24`) and "stop" elsewhere (`ship:36`, `:62`).** Observable in principle: a ship session's assistant text under `attribution_skill='ship'` says which it did. The corpus holds 3 Claude ship sessions (2026-08-13 `c921bd7f`, 2026-08-28 `602c4605`, 2026-09-13 `b31b9303`) and 14 Codex threads that read the file, all under the same single version. That is a reading list of 17 sessions, not a metric; the DB's contribution is producing the list with locators in under a second.

**What it can support.** Agreed: this is badly confounded — tasks differ between arms, `review` edits on 08-05 and 09-04 landed alongside edits to other skills the same sessions loaded, the Claude corpus is one model throughout so a model transition cannot even be separated, and per-version samples are tens of sessions for the top five skills and single digits for the rest. It yields "this rule's sessions look different after the change — go read them / put it in an eval", never "this rule helped". For a comparison to be worth acting on, all of these would have to hold: the same skill version on each side with no other loaded skill changing in the same window (checkable from `skill_version`); the same tool and model family on both sides (a column); the same project or task class (the owner's judgment, from the session list); a mechanical outcome — spawn count, commit count, interrupted turns — rather than a judged one; and at least a few dozen sessions per arm. Where those hold, the DB gives the two arms and their locators; the eval harness with the two versions as fixtures gives the answer. Where they do not, the query still returns the arms and says how small they are, which is the honest output.

## 10. Read path

**Shape**: `dim q <name> [--project <cwd>|--all-projects] [--since 30d] [--model <m>] [--tool claude|codex] [--skill <name>]`. Bash + sqlite3, each named query a `.sql` file under `queries/`, output as aligned text capped at 40 rows; `--json` for the eval export. Raw SQL stays available (`sqlite3 ~/.local/share/dim-factory/sessions.db`) for the owner; the agent uses only named queries. A TUI or dashboard is not built: the audience is one person and one agent, and 40 lines of text is the right size for both.

**Named queries**:

| Query | Returns |
|---|---|
| `skills` | per skill: loads by `how`, by tool, avg body chars, re-read count (§9.2), first/last seen |
| `skill <name>` | one skill split by each edit to its body: loads, sessions, body chars and what the user stopped under each version |
| `corrections [--skill]` | candidate list: ts, session prefix, skill, model, kind, 200-char excerpt, label if any |
| `label <message_id> <label> [--rule]` | writes `correction_label` |
| `routing [--skill]` | counts of positives / misses / wrong-skill; `export routing-cases` for the JSONL |
| `tokens` | per model and tool: input, cache read, cache write, output, reasoning; per session top 10 |
| `session <id-prefix>` | one session: models, turns, tokens, tool counts, skills loaded, commits, end reason |
| `tools` | tool_name counts and read:edit ratio per project/model; files edited ≥2 times in a session |
| `workflow` | skill transition counts; plan→build→review adherence fraction |
| `models` | sessions, tokens, skills loaded per model per month — descriptive only, no comparison column |
| `cost` | Claude-reported USD per session/month; "not reported" for Codex |
| `search "<terms>"` | messages whose text matches, newest first: session prefix, ts, role, project, matched excerpt |
| `thread <id-prefix>[@<ts>]` | what was said in one session, in order, or the messages either side of a timestamp |
| `resume <id-prefix>` | the factual half of a handoff: branch, files in play by last touch, failures, last pushback, last exchange |
| `candidates [skill]` | unlabeled stops with 200 characters of what was said, to be judged by reading |
| `delegation` | work handed to a subagent or a peer, by the skill that handed it over |
| `running [minutes]` | sessions and subagents active in the last few minutes, and what each is doing |
| `repeats [n]` | phrases used across several sessions when prompting or stopping the agent |
| `digest` | one call for a scheduled reader: friction, where work happened, what recurred |
| `stale [id-prefix]` | how far the code a session touched has moved since it ran |
| `fixes` | files an agent edited that a later `fix:` commit came back to, by skill |

**Agent invocation**: the stations under `skills/`, linked into `~/.agents/skills` and `~/.codex/skills` by `dim install-skill`. A station differs from a tool-agnostic engineering skill by reading the record: `dim-plan` gathers prior art, decisions already taken and whether an earlier conclusion still holds, then hands the planning to a more capable model; `dim-review` runs one agent per dimension, aimed by the files a later fix commit came back to. They live here rather than in the skills repo because they are useless without `dim` on PATH; the `dim-` prefix marks one. A symlink rather than a copy, so an edit is live with no reinstall and no second copy to drift; anything already at the name is moved aside rather than removed, and a link left by a station that no longer ships is removed, so a name never resolves to nothing. Each station carries the section a query result cannot: what the database does not hold, so an absence is reported as a gap rather than as a finding.

**A correction belongs to the version that was loaded.** `q skill` ties each stop to the `body_sha256` of the load in that session at that time, not to the text on disk now, so rewriting a skill cannot take credit for what the old wording did. The arms this produces are thin — `handoff` has 132 versions across the corpus and 121 were loaded in a single session — so the count of single-session versions leads the denominator, ahead of the table, and the note says the rows point at sessions to read rather than at a version that scored better. Codex reads a skill file itself and reports no body, so its loads carry no hash and collect in one `(unmeasured)` row instead of splitting.

**A handoff can be shorter than the past it covers.** A handoff carries everything because the next session has no way to reach what came before; once `search`, `thread` and `resume` exist, it can name a session id instead of restating it. `resume` returns only facts — branch, the files in play ordered by last touch rather than by count, tool failures, the last pushback, the last exchange — and no next move, because that is the judgement the handoff exists to make and a row claiming it would read as measured. The session writing a handoff is usually the one whose context is nearly full, which is when recall is worst and reading from disk is worth most.

**A shared record, not a channel.** The database is the only thing on the machine that reads Claude, Codex and Acolyte sessions alike, so it is already how one tool learns what another did — a Claude session recovers a decision made in Codex by querying it, and the reverse. dim does not carry messages between running agents and should not: a message needs both ends live and a runtime to deliver it, and nothing here reaches the network or holds a credential. `install-skill` therefore links into `~/.agents/skills` — the convention Claude and Acolyte both read (`acolyte/src/skill-ops.ts:12`) — and into `~/.codex/skills`, which Codex reads instead.

**Fanning out costs visibility, and the transcripts are already on disk.** A delegate writes its own transcript as it works, so `q running` reports what every session and subagent touched in the last few minutes without waiting for anything to report back. It is as fresh as the last `dim sync` and says so; nothing here watches a file.

**The only outcome signal is the repo's own.** Every other table here is process — what was said, loaded, called, stopped — and process cannot say whether the code was right. `repo_commit` and `commit_file` are read with `git log` from the repos the session rows already name, so the cost is disk and CPU and nothing else. Conventional Commits makes the verdict free: a `fix:` commit naming a file is a statement that the file needed changing, written at the time by whoever had to come back, with no annotation effort and no hindsight.

A fix is only counted when it lands after the session ended. Within a session a file is edited and re-edited as ordinary work, and counting those as defects rated the skills that run on hot files worst — `simplify` at 53% with a mean lag of seven hours, which measures how busy the file was, not how wrong it was. Even after the gate the figure is co-occurrence: a fix may land on code the session never wrote, work nobody came back to may still be wrong, and a fix committed without the prefix is invisible.

**Which rules were in force.** `skill_load` carries a body hash on every load, so a skill can be split by version; `AGENTS.md` and `CLAUDE.md` carried nothing, and they govern every session — including the large majority of file edits made under no skill at all ([`findings.md`](findings.md)). `guidance_version` closes that: a file inside a repo gets its whole history from `git log --raw`, which names the blob each commit left behind, so one pass over the log yields every version without a `rev-parse` per commit. A file outside a repo — `~/.claude/CLAUDE.md` is not version-controlled — can only be hashed as each sync finds it, so its history begins when collection does.

What that leaves out is the walk: which surfaces were in force together, and which one imported another. The same project file governs different work depending on what sat above it, and only the session that started can say what it read. `guidance_walk` closes that — `dim wake` resolves the surfaces at `SessionStart` and writes them to the spool, and `sync` drains them. Granularity is the session start, so a rules file edited mid-session is missed; the alternative is capture on every turn, which costs a process per turn to record something that changes a few times a year.

A worktree is its own path here, so the same file appears once per checkout. That is deliberate: an agent working in a worktree read that copy, and the copies diverge.

**A rule stated three times is guidance, not a memory.** `q repeats` counts the phrases the owner used across several sessions when typing a prompt or stopping the agent — no model, no judgement, only counting. The point is where a recurring correction belongs: a fact filed in a memory store has to be retrieved by something that already suspects it exists, while `AGENTS.md` and `CLAUDE.md` are loaded in every session, including the majority that load no skill. Promoting a phrase that recurs into the guidance is what makes it fire without being asked.

Two filters make the counts mean anything. A message over 400 characters is a document, not a sentence — without that cut the result is dominated by the handoff template, pasted into 207 sessions. And a turn the tool wrote for the user, such as an interruption marker, is not something anyone said. What survives is still only a place to look: a phrase may be a habit of speech rather than an instruction.

**The measure step is a job, not a sitting.** `digest` answers over whatever window it is given — `--since 7d` for a weekly cadence — and computes nothing of its own: every figure in it is reachable from another query, so a number has somewhere to be checked. It reports friction, the share of edits made under no skill, work handed out, how many skill and rules versions moved inside the window, and the phrases that recurred. Guidance churn sits beside the numbers deliberately: a change in one with a change in the other is where crediting the wrong cause starts.

**How far a session's ground has moved.** `stale` joins the files a session edited to the commits that landed on them afterwards, which is the gate `acolyte import` settled on, measured per file rather than per repo. It reports the share of those files committed to since and the number of commits in total, because neither alone is the score: the share says whether the ground moved, the count how far. It scores the area rather than the work — a file under constant edit moves whatever was done to it — so a high figure means this session's conclusions are about code that has changed, never that the session was wrong.

**A repository is named by its remote, not by where it sits.** `repo_commit.label` is the `owner/repo` its remote addresses, lowercased with the host dropped, so a repository keeps its name across forges and a worktree carries the same one as the checkout it belongs to. The derivation is Acolyte's (`acolyte/src/git-remote.ts`); dim needs it for something a single runtime does not, which is that one project appears here as several checkouts — three for the largest product line, two each for the next two. Paths stay per-checkout because a session edited the file at the path it saw; the label is what groups them.

**The read path is for the agent first.** The queries that count — `skills`, `tools`, `corrections`, `rework` — answer a question the owner asks about the corpus. The queries an agent reaches for mid-task are `search` and `thread`: find the sentence, then read the exchange around it, because the sentence that settled a question is rarely the one that matched. Until a query changes what an agent does in the session it is run in, it is a report, and reports are not what this is for.

**What the repos already decided.** `repo_file` is what each checkout tracks right now, replaced whole from `git ls-files` on every sync, against `commit_file`'s record of what a repo once held. The two answer different questions: a rename is a delete and an add in the history, and a file dropped years ago keeps its rows there, so a reader sent to a path from the history finds nothing. `prior-art` reads the current table and dates each file from the commits that touched it, which turns "how did I solve this before" from a survey of every checkout into one query. It ranks by recency and commit count, which is not quality — a file copied between repos reads as settled as one that was worked out — and caps any one repo at three files, because a repo with fifty workflows would otherwise be the whole answer.

**The window is a spend control, not a correctness rule.** Every query covers the last 30 days unless told otherwise, because guidance, projects and habits all changed across the corpus and a count over all of history describes a machine that no longer runs. The constant is arbitrary — the same species as a default turn cap — so `--since <n>d|YYYY-MM-DD` moves it and `--all` removes it, the window appears in the denominator line, and the counts a rate divides by are windowed with the rows. `models`, `cost`, `session` and `search` span history by default, since a time series narrowed to a month is not one.

**Search is an index, not a scan.** `message_fts` is an FTS5 index over `message.text` with external content, so it stores no second copy and reads the text back through `message.rowid`; insert, update and delete triggers keep it level with the table, and `rebuild` drops it first because clearing rows one by one would ask the index to forget entries an older schema never gave it. It holds prose only: a message with no text is a tool call or its result. Terms are quoted before they reach FTS5, so a branch name or a flag searches as the word it is rather than as `NOT` or a column filter.

**Meaning is a brute-force scan, and the keyword index is what it falls back to.** `embedding` holds one 384-float unit vector per distilled passage — a handoff's `## Next` as `wake` would deliver it, a commit subject the owner authored, a prompt labeled a correction — and `q search` embeds the question, scores every vector with a dot product, and shows the closest twenty. No vector store and no daemon: a corpus this size scans in milliseconds, so the cost is a blob column and nothing else. The table is a projection and never a second archive, so `dim embed` drops a row whose source is gone; it carries no foreign key, because `rebuild` empties `message` and drops `repo_commit` before writing the same ids back. `text` is stored beside the vector because a vector means nothing except against the exact string the model was given, and a `Next` is a slice of a larger message that exists nowhere else. Where nothing is embedded, the model will not load, or the database predates the table, `search` answers from `message_fts` and says so in its denominator — a retrieval path that can break is one nobody relies on. What it does not hold is raw conversation turns, which are the measured-worse input; whether adding them helps is for a benchmark, not an assumption.

**A re-run embeds only what changed, by hash rather than by cursor.** `text_sha` and `model` are the key: a passage whose text and model both match what is stored costs one hash, and changing either re-embeds it. So `dim embed` needs no cursor of its own — the byte cursor that makes `sync` incremental has nothing to say about a table derived from rows it already wrote. What the hash does not avoid is re-reading every distilled passage each run, which is a full scan of the table and a hash per row: measured at 3.6s over 5,864 passages on 2026-09-17, against 46 minutes for the first pass. A cursor would buy those seconds and nothing else.

**The scan has a ceiling, and the recorded scopes are what raises it.** Every query reads every vector, which is what makes the design need no index and no daemon. That holds to roughly a million passages — measured as the whole-corpus shape at 89,557 blobs: 71ms to read them, 29ms to pack, 37ms to scan. Past that the fix is filtering before scanning, and the filters are the scopes already in the schema — project, session, skill, repo, commit — which is the second reason not to invent a topic layer. A model download is the one thing here that touches the network, and it happens once; every embedding after that is local, uncredentialed and unbilled.

**A scratch tree is not the work.** `ingestCommits` reads the repos the session rows name, and an agent's own temp directory is one of them: a session working under `/private/tmp` commits there, and those subjects describe changes to files the OS will delete. `src/scratch.ts` is the one definition of the rule, applied where session directories become repos rather than in each query — a commit excluded there is excluded from `prior-art`, `fixes`, `exemplars` and the embedding index alike. Rows ingested before the rule leave on the next `dim rebuild`; nothing here deletes them at sync time, because a migration is a step someone takes and not a shape the code keeps.

**Three states, never two.** A query reports conformed, violated, or *not exercised*, and the third is never folded into the first two. Every result carries the base its numbers came from, printed above the rows, and a result with no rows prints why rather than an empty table a reader scores as zero. Where a figure covers a subset — Codex rollouts before roughly March 2026 emit `task_complete` with no `started_at` or `duration_ms`, so 8,896 of 18,094 turns are counted but not timed — the denominator names the subset instead of leaving a total that does not add up. No duration is derived for those turns: `completed_at` minus the `turn_context` timestamp is a different measurement, and mixing two into one column is worse than a gap.

**An agent reads this output, not a person.** The consumers are the skills that call the CLI, and none of them passes `--json` — they read the table. So a number prints as digits with no thousands separator, because a separator is punctuation a reader has to strip; cells are separated rather than padded out to the widest value in their column, because alignment buys a person columns that line up and costs the agent a run of spaces on every row; and a cell that would widen every row is truncated where the distinctive end survives: a commit from a checkout with no remote is named by the tail of its path, not by the temp directory it starts with. A result longer than the cap says how many rows were cut and names `--rows`, so a short table is never read as the whole answer. What stays is the prose — the denominator above the rows and the note below them — which is the half actually written for a model, and is why an empty result prints why rather than an empty table.

**The reader cannot write.** `openReadOnly` is the only way a query reaches the database, and it opens with SQLite's read-only flag. Everything else here is rebuilt from the source files, but `hook_event` has no source to re-read from, so a wrong query typed by the owner or issued by an agent must not be able to reach it.

**Safety of the read path**: the DB never contains tool results, file contents, diffs or stdout, so no query can return them. Text-returning queries (`corrections`, `routing`, `session`) default to the current `cwd`'s project; `--all-projects` is required to see another project's prompts, and the skill tells the agent not to pass it. `command` strings are shown only by `session` for the current project. Everything else is aggregates.

## 11. What it is not

- Not a cost calculator: no price table, no derived dollars.
- Not a judge of skill quality: no outcome ranking, no skill-vs-no-skill comparison, no length-vs-outcome metric.
- Not a search tool over transcript content; `search-sessions` already does that against the files.
- Not a compliance checker for skill instructions; that is `evals/`.
- Not multi-machine or multi-user; one home directory, one SQLite file.
- Not a hook-heavy telemetry layer: two hook events per tool, each a file write.
- Reaches no network, holds no credential, and is billed for nothing at any point in collection or backfill; a model reads query output only when the owner asks, on a set the query has already narrowed, and the local embedder reads only text a person distilled.

## 12. Build order

Each slice is one commit in `~/code/dim-factory`, independently useful.

1. **Sessions, messages, usage** — `dim init`, `dim sync`, `dim rebuild`, `dim stats`; `parse-claude.ts` and `parse-codex.ts` populate `session`, `message` and `usage` for Claude transcripts, Claude subagents and Codex rollouts. Archiving is not a slice: `cleanupPeriodDays` is set to 3650, so the sources persist and the database points into them (§4). *Useful on its own: every token figure in §3.5 and §3.10 is answerable.*
2. **Hook spool** — the four hook commands added to `~/.claude/settings.json` and `~/.codex/hooks.json`; `sync` drains the spool into `hook_event`. Second because it is the only slice whose data expires: a session that ends before its hook is installed never records why it ended, and no later slice can recover it. This is §1's argument, which the transcripts no longer need and the hooks still do.
3. **Scheduled sync** — a `launchd` agent running `dim sync` every 15 minutes, so the database tracks the corpus instead of being a snapshot, and the spool is drained while it is small.
4. **Turns and reported cost** — `turn` from Claude's `turn_duration` lines and Codex's `task_complete`/`turn_aborted` events, `session_cost_reported` from Claude's `cost-state`. A Codex turn takes its model from its own `turn_context`, not from the turn in effect when it finished. Rollouts whose `turn_context` carries no `turn_id` (the pre-August dialect) leave the model unset rather than guessed.
5. **Orphan prompts** — `orphan_prompt` from both `history.jsonl` files, for the sessions whose transcripts were deleted before §1's retention change.
6. **Read path** — `q tokens`, `q session`, `q models`, `q cost`.
7. **Tool calls and edits** — `tool_call` for both tools; `q tools`.
8. **Skill loads and versions** — `skill_load` with `how` and `body_sha256`; `skill_version` from the skills repo's git history; `q skills`, `q skill`, `q workflow`; the `review_scope` derivation for §9.9 case 1.
9. **Corrections and routing** — `v_correction_candidate`, `v_routing_case`, `correction_label`; `q corrections`, `q label`, `q routing`, `export routing-cases`.
10. **Agent skill** — `skills/session-evidence/SKILL.md` in the skills repo, validated with `make validate`, dry-run per `skill-test`.

Slices 4–10 read only the source files, so they rebuild at any time and a schema change is `dim rebuild`, not a migration. Slice 2 is the exception: the spool is the one input that exists only if something was running when the session ended.

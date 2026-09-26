# Reaching a session without being asked

Most of what this repo knows is reachable only by a query someone decides to run. The sessions that most need a fact are the ones with no reason to suspect it exists, so a store that answers well when asked is not the thing missing. What is missing is a channel that arrives.

## The channel

A `SessionStart` hook's plain-text stdout is added to the session as context the model can act on, and Codex takes the same block as `hookSpecificOutput.additionalContext` on that event. That is the one path here reaching a session before anyone forms an intention, and `dim wake` uses it: the `## Next` left by the last session that worked in this directory, and the check and format commands the repo itself declares.

It is the only hook here that spends rather than records. What it prints is paid for in every session that starts, so a line goes in only where a cold start could not reach the same fact for less, and where neither half has anything to say it prints nothing. The two halves fail apart: the Next needs the database, what the repo declares does not, and the session before the first sync is the one most helped by being told the check.

## The chain a handoff already makes

A handoff is printed into the transcript before it is pasted, so the same text lands in two sessions: the one that wrote it and the one that carried it forward. Neither knows about the other — `session.parent_id` links a subagent to its parent and nothing links a session to the one it continues, so a task spanning several sessions reads as several unrelated cold starts, and every per-session measure is distorted by whatever the chain depth was. `stale` is the sharpest case: for every link but the last, the ground moved because the next link moved it.

The handoff record is recoverable from text already collected, and `sync` backfills strict `# Handoff` plus `## Next` pairs into `factory_handoff`. Wake reads that projection rather than parsing transcript text. The edge is then recoverable from the same records in `handoff_link`. The title line is the key and matches on both sides; where a title was reused, the nearest preceding printer in another session is the writer. Unlike an end reason, nothing has to be captured as it happens — a handoff with no match links itself as soon as the writing session is read, which is why both tables are derived and replaced whole rather than appended to.

`q resume` reads the stored Next for a session; it does not infer a next move from branch, file or message facts.

`q chain` reads it two ways. Grouped by title it ranks the tasks that spanned the most sessions; walked from one session it follows the edge in both directions, so it crosses a task that was renamed midway and branches where one handoff was pasted into two sessions. Around one paste in five finds no writer, because that session's transcript was pruned before it was ever read.

Two rules that look right and are not. Matching the `# Handoff` heading alone catches every session that merely discussed one, including the session asking. Keying on the `handoff` skill's attribution misses the handoffs written under no skill, which are a substantial minority ([`findings.md`](findings.md)). What holds is the heading together with a `## Next` that parses.

## Why not a memory store

Three were considered: Acolyte's memory, a vault, and MemPalace.

Acolyte's distils observations with a model and recalls them when the model decides to search. Both halves are wrong here — a distiller is a model call in backfill, and on-demand recall inherits the reach of whatever invoked it, which is the fraction of work that loads a skill at all.

A vault is markdown an agent must be told to read, so it sits further behind an invocation than the database already on disk.

MemPalace is the closest: verbatim, message-level, local, no API calls for retrieval. But it reads the same transcripts through the same hooks, so running it means collecting twice, and its wake-up is still a command someone runs. What it has that this does not is semantic retrieval.

So the gap is not storage. This database already holds every message with richer scoping than a memory store would build — project, session, skill, repo and commit.

## Scope, and which tier arrives

[Nothing Forgotten](https://crisu.me/blog/nothing-forgotten) separates memory into three scopes — what the work is on now, what holds for this project, and what holds for this person — and the same three exist here. The session tier is the Next a handoff left, and `wake` delivers it. The user tier is the conventions file, which is resident in every session and is what [`conventions.md`](conventions.md) exists to cut. The project tier — how this repo is built, tested and released — is recorded nowhere that arrives, and is exactly what gets re-explained at the start of a session.

### What the project tier would carry

The facts re-explained at the start of a session are how this repo is formatted, tested, deployed and reviewed. They are per-repo, they change rarely, and an agent that has to work them out reads a manifest and a lock file to reach them.

The workspace detector reads the project files that establish its tooling: package manifests, lock files, task files and language configuration. It combines every matching ecosystem into one profile, because a repository may contain several workspaces. Each command carries the file or detector that produced it, so the builder can see the evidence without guessing a tool.

The profile still selects the repository's own check and formatter from its named tasks. Those selections are the commands the factory treats as canonical; detected ecosystem commands give the builder useful install, analysis and test commands where the repository has not named an equivalent task. A missing command stays missing rather than becoming a guess.
- **The tooling chain, derived.** Which CLIs a repo is actually worked with is already recorded, because every shell command a session ran is a row: across the corpus one line deploys with wrangler, three with vercel, and `gh` is used in all of them ([`findings.md`](findings.md)). No config file has to be parsed for this and no heuristic can do better, because the source is what was run rather than what is installed.

- **The worker environment.** A workspace profile also needs the setup boundary a factory worker will enter: languages, package managers, workspace members, declared setup and cleanup hooks, required services, isolation strategy, and resource or secret requirements. A multi-workspace repository demonstrates the local case: one worktree can install several package ecosystems, activate pinned tools, allocate ports, create per-worker service containers, link environment files and remove those resources on teardown. The profile describes and reports that lifecycle; the repository-owned hooks perform it. `dim wt` keeps a worktree when cleanup fails, and the factory attaches setup and teardown evidence to the order rather than treating the environment as invisible preamble.

The delivery is the one that already exists. `wake` is the only channel here that arrives, and it holds a budget: every line is paid for in every session that starts. Three commands and a tooling chain fit that budget on its own terms, because a cold start can work them out but only by spending a tool call and its output to do it — which is more than the lines cost. What does not fit is everything else about a repo, and the test for adding a line stays the one `wake` was built with: a cold start cannot work it out, or it does not go in.

Running a formatter after each edit is a planned `PostToolUse` action. The hook will identify edit operations, resolve the checkout from the event's working directory, and use the repository's declared `formatTask`; it will pass changed paths where the task's command line supports the `$FILES` placeholder, record the command line and result, and fail open. Acolyte's workspace-contract shape is useful for that boundary, while its detectors that infer the underlying formatter are not: the task the repository declares remains authoritative. The current hook only spools the event; the formatter action is tracked separately in [`build-order.md`](build-order.md).

On Codex the hooks fire only while their position is trusted. Trust is recorded per hook in `~/.codex/config.toml` as `<hooks.json path>:<event>:<entry index>:<hook index>`, so an entry inserted ahead of dim's by another tool moves dim's hook to a key approved for a different command. `doctor` reads whether a trust is recorded at each hook's current position, which is what turns that from silent into reported.

Two of its principles are rules here rather than observations. Relevance over recency: a session's own Next is the one place recency is the right key, because continuation is what it is for, and `prior-art` ranking by recency is the flaw it already names in its own note. And degradation rather than failure: where an embedding is missing or the model will not load, search falls back to the keyword index instead of erroring, because a retrieval path that can break is a query nobody can rely on.

## Input quality decides this, not the algorithm

Measured already, on LoCoMo, and published as [The Distillation Gap](https://crisu.me/blog/the-distillation-gap): distilled observations beat raw conversation turns at every k, the two shipped retrieval improvements are worth about four points between them, and the distillation step before retrieval is worth seven. Better retrieval does not fix worse input.

The same finding settles topics. Structural filtering works where the topic assignments are good and adds noise where they are keyword-derived — the mechanism is right and the data is the bottleneck. So a topic layer here would have to be as good as the scopes already recorded, and the scopes are recorded rather than inferred.

That is a cost to embedding every message here, not a reason against it: raw turns are the weaker input, and a distiller is the one thing collection may not do. What this corpus has instead is text a person already distilled. A handoff is a session compressed by hand to what the next one needs, a commit subject is one change stated in a line, and a correction is the moment the work was stopped. None of them needs a model to produce, because all of them were written.

So the first thing to embed is what was distilled by hand, and whether adding raw messages helps is a question for the benchmark rather than an assumption.

## What semantic search would cost

Keyword search finds the words that were typed. A question and the passage that answers it routinely share no tokens, and the corpus records the failure in its own voice: *"my earlier search was too narrow to catch it — I was matching phrases like 'from Claude,' not the concept."*

The mechanism is settled and needs no vector store. Acolyte keeps embeddings as a `BLOB` beside the rows and scores them with a cosine over `Float32Array` views; brute force over a corpus this size is milliseconds, so a database and a daemon would buy nothing. What changes is the provider: Acolyte embeds through a remote API, and a local model is what keeps this offline and free.

One constraint stood in the way, and deliberately: collection makes no model call, and a model reads query results rather than transcripts. Embedding every message is a model reading every transcript. The reasons behind that rule — no network, no credentials, no per-token cost — all survive a local embedder, so the rule now states what it protects: nothing reaches the network, holds a credential, or is billed per token, and no model reads a transcript. A local model over text a person distilled breaks none of that.

## Measuring whether retrieval improved

A ranking change with nothing to falsify it is a preference. The metrics are here, in `src/rank-metrics.ts`, defined locally so a score keeps its meaning across years. What Acolyte's harness still holds is the adapters that normalize LongMemEval and LoCoMo into scenarios; its scenario layer is coupled to distilled observations and does not transfer.

LongMemEval is worth taking for one reason beyond convenience: it is what MemPalace publishes against, so it is the only way a claim made there becomes a claim checkable here.

The set that decides a change is drawn from this corpus instead, and is hand-labeled today; [`design.md`](design.md) has its shape and `dim bench` scores it. A handoff and the session that acted on it are a query and its known answer that nobody had to invent, and the chain already pairs them, which is how the set grows past what one agent thought to ask. Both halves are needed: the external set says whether retrieval is good, the corpus-native one says whether it is good at the questions actually asked here.

Neither measures the thing this file is about. No recall figure can say whether anyone thought to ask, which is why the session-start channel is not evaluated this way and cannot be.

## What stands today

`wake` is installed, and so is semantic retrieval over the distilled text: `dim embed` writes a unit vector per passage into `embedding`, and `q search` scores them by cosine, falling back to the keyword index when nothing is embedded, the model will not load, or the database predates the table. That keyword index has a door of its own, `q keywords`, ranked by how many of the asked-for words a message carries rather than requiring every one, so a decision settled in conversation and never distilled is reachable by the words it was settled in rather than only when the meaning path breaks. The chain is built: `sync` fills `handoff_link` and `q chain` walks it. The corpus-native benchmark is wired up — `dim bench` scores a labeled set through the queries and reports recall@k and nDCG@k — and its first reading is in [`findings.md`](findings.md). The external set is not, so a claim published elsewhere is still not checkable here.

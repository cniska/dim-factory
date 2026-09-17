# Reaching a session without being asked

Most of what this repo knows is reachable only by a query someone decides to run. The sessions that most need a fact are the ones with no reason to suspect it exists, so a store that answers well when asked is not the thing missing. What is missing is a channel that arrives.

## The channel

A `SessionStart` hook's plain-text stdout is added to the session as context the model can act on, and Codex takes the same block as `hookSpecificOutput.additionalContext` on that event. That is the one path here reaching a session before anyone forms an intention, and `dim wake` uses it: the `## Next` left by the last session that worked in this directory, and nothing else a query can answer.

It is the only hook here that spends rather than records. What it prints is paid for in every session that starts, so it carries one thing, and where the last session left no Next it prints nothing.

## The chain a handoff already makes

A handoff is printed into the transcript before it is pasted, so the same text lands in two sessions: the one that wrote it and the one that carried it forward. Neither knows about the other — `session.parent_id` links a subagent to its parent and nothing links a session to the one it continues, so a task spanning several sessions reads as several unrelated cold starts, and every per-session measure is distorted by whatever the chain depth was. `stale` is the sharpest case: for every link but the last, the ground moved because the next link moved it.

The edge is recoverable from text already collected. The title line is the key and matches on both sides; where a title was reused, the nearest preceding printer is the writer. Unlike an end reason, nothing has to be captured as it happens — a handoff with no match links itself as soon as the writing session is read.

Two rules that look right and are not. Matching the `# Handoff` heading alone catches every session that merely discussed one, including the session asking. Keying on the `handoff` skill's attribution misses the handoffs written under no skill, which are a substantial minority ([`findings.md`](findings.md)). What holds is the heading together with a `## Next` that parses.

## Why not a memory store

Three were considered: Acolyte's memory, a vault, and MemPalace.

Acolyte's distils observations with a model and recalls them when the model decides to search. Both halves are wrong here — a distiller is a model call in backfill, and on-demand recall inherits the reach of whatever invoked it, which is the fraction of work that loads a skill at all.

A vault is markdown an agent must be told to read, so it sits further behind an invocation than the database already on disk.

MemPalace is the closest: verbatim, message-level, local, no API calls for retrieval. But it reads the same transcripts through the same hooks, so running it means collecting twice, and its wake-up is still a command someone runs. What it has that this does not is semantic retrieval.

So the gap is not storage. This database already holds every message with richer scoping than a memory store would build — project, session, skill, repo and commit.

## What semantic search would cost

Keyword search finds the words that were typed. A question and the passage that answers it routinely share no tokens, and the corpus records the failure in its own voice: *"my earlier search was too narrow to catch it — I was matching phrases like 'from Claude,' not the concept."*

The mechanism is settled and needs no vector store. Acolyte keeps embeddings as a `BLOB` beside the rows and scores them with a cosine over `Float32Array` views; brute force over a corpus this size is milliseconds, so a database and a daemon would buy nothing. What changes is the provider: Acolyte embeds through a remote API, and a local model is what keeps this offline and free.

One constraint stands in the way, and deliberately: collection makes no model call, and a model reads query results rather than transcripts. Embedding every message is a model reading every transcript. The reasons behind that rule — no network, no credentials, no per-token cost — all survive a local embedder, so the rule should be rewritten to say what it protects rather than quietly broken by a retrieval feature.

## Measuring whether retrieval improved

A ranking change with nothing to falsify it is a preference. Acolyte already has the harness: recall and nDCG at k as pure functions, and adapters that normalize LongMemEval and LoCoMo into scenarios. Its scenario layer is coupled to distilled observations and does not transfer, but the metrics and the adapters do.

LongMemEval is worth taking for one reason beyond convenience: it is what MemPalace publishes against, so it is the only way a claim made there becomes a claim checkable here.

The set that should decide a change is drawn from this corpus instead. A handoff and the session that acted on it are a query and its known answer, and the chain already pairs them. Both halves are needed: the external set says whether retrieval is good, the corpus-native one says whether it is good at the questions actually asked here.

Neither measures the thing this file is about. No recall figure can say whether anyone thought to ask, which is why the session-start channel is not evaluated this way and cannot be.

## Not built

`wake` is installed. The handoff chain, and semantic retrieval, are not.

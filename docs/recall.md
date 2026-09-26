# Recall

A query answers only when someone thinks to ask, and the sessions that most need a fact have no reason to suspect it exists. Recall here is a channel that arrives without being asked, plus retrieval for when someone does ask.

## `dim wake`

- A `SessionStart` hook's stdout becomes context in the session (Codex reads it as `hookSpecificOutput.additionalContext`). `dim wake` prints the `## Next` left by the last session that worked in this directory, and the check and format commands the repo declares.
- Every line it prints is paid for in every session that starts, so a line goes in only where a cold start could not reach the fact for less. With nothing to say, it prints nothing.
- The two halves fail apart: the Next needs the database, the declared commands do not.
- On Codex a hook fires only while its position is trusted in `~/.codex/config.toml`, keyed by entry index, so another tool inserting a hook ahead of dim's moves dim's off its trusted key. `dim doctor` reports it.

## The handoff chain

- `sync` reads each `# Handoff` with a parseable `## Next` into `factory_handoff`, and links it to the session that pasted it in `handoff_link`. The title line is the key; a reused title matches the nearest preceding writer in another session. Both tables are derived and replaced whole.
- The heading alone is not enough — it matches every session that discussed a handoff — and the `handoff` skill's attribution misses handoffs written under no skill.
- `q resume` reads a session's stored Next and infers nothing. `q chain` ranks tasks that spanned the most sessions, or walks the chain from one session in both directions.

## Retrieval

- **Input beats algorithm.** Distilled text retrieves better than raw turns ([The Distillation Gap](https://crisu.me/blog/the-distillation-gap)), so what is embedded is text a person already distilled: handoffs, commit subjects, labeled corrections. Whether raw turns help is a question for the benchmark.
- **Local only.** The embedder runs on disk, reads no transcript and no raw turn, and nothing reaches the network or is billed.
- **Degrade, don't fail.** `q search` falls back to the keyword index when nothing is embedded or the model will not load.
- [`design.md`](design.md#search) has the mechanics and the benchmark format.

What is not built is in [`todo.md`](todo.md).

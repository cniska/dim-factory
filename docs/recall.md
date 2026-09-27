# Recall

Agents recall earlier work by querying the local record when the task calls for it. `dim q resume <id>` retrieves a handoff's next move; `dim q search` finds what was said earlier by the words in it.

## The handoff chain

- `sync` reads each `# Handoff` with a parseable `## Next` into `factory_handoff`, and links it to the session that pasted it in `handoff_link`. The title line is the key; a reused title matches the nearest preceding writer in another session. Both tables are derived and replaced whole.
- The heading alone is not enough — it matches every session that discussed a handoff — and the `handoff` skill's attribution misses handoffs written under no skill.
- `q resume` reads a session's stored Next and infers nothing. `q chain` ranks tasks that spanned the most sessions, or walks the chain from one session in both directions.

## Retrieval

`q search` matches words in what people and agents said, across every session, and each hit names the exchange `q thread` reads. [`design.md`](design.md#search) has the mechanics.

What is not built is in [`todo.md`](todo.md).

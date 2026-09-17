---
name: df-sessions
description: Recover what was said, decided or measured in a past Claude Code or Codex session, from the local dim-factory database. Use when a decision, number, or plan was discussed earlier and is not in the repo, or not where you expect it.
argument-hint: "<subject>"
---

# Session evidence

Every Claude Code and Codex session on this machine is already indexed in a local SQLite database. Ask it, rather than grepping transcripts: a transcript line carries whole tool results and file contents, so the files run to megabytes and a match is mostly machinery.

Prerequisite: `dim` on PATH. If it is missing, say so and fall back to the `search-sessions` skill, which needs nothing installed.

## Workflow

1. **Find the passage.** `dim q search "<question>"` — ask it as a question, in whatever words fit; it ranks by meaning, so a hit need share no term with what you typed. It searches the text a person distilled by hand: the `## Next` a handoff left, the subjects of commits the owner authored, and prompts labeled corrections. A sentence said in passing is not in it. The denominator names which index answered — `cosine over N distilled passages`, or `keywords over N messages` when nothing is embedded or the model will not load, in which case terms are ANDed and match as literal words. Run `dim embed` if it keeps falling back.
2. **Read around it.** `dim q thread <session-prefix>@<ts>` returns the messages on both sides of that timestamp. The exchange that settled a question runs three or four messages, and the sentence that changed the answer is rarely the one that matched. `dim q thread <session-prefix>` alone reads the session from the start.
3. **Take the session's facts if they bear on the answer.** `dim q session <id-prefix>` gives models, turns, tokens, tool counts, interruptions and end reason.

Before editing a skill, run `dim q skill <name>`: it splits that skill by each edit to its body and shows what the user stopped under each version. Most versions were loaded in a single session — the denominator says how many — so it points at sessions to read, never at a version that scored better.
4. **Check the artifact against the current checkout.** A decision committed in another checkout and never pushed, or written to a file on a branch you are not on, is invisible from where you stand. Verify on the current branch before reporting a decision as present or missing, and say which it is.

Queries cover the last 30 days by default and print the window above the rows. Pass `--since <n>d`, `--since YYYY-MM-DD` or `--all` to move it — `search` and `thread` already span all of history.

## What the database does not hold

Say which of these applies rather than reporting an absence as a finding:

- **`search` ranks distilled text, not every message.** A sentence typed once in one session is not a passage anyone summarized, so ranking by meaning cannot reach it. When the keyword fallback is what you need, `dim sql` reaches every message through `message_fts`.
- **Tool calls and their results carry no text.** Roughly a third of messages are searchable prose; the rest are machinery, deliberately not indexed. A command you ran is in `dim q tools`, not in `search`.
- **Skill bodies and injected meta are excluded from `thread`**, being the largest text in a session and said by no one.
- **A session synced before its last turn is short a few messages.** `dim sync` reads new bytes; run it if the exchange you want is from the last few minutes.
- **Prompts from sessions whose transcript is gone** are recorded without their replies.

## Reporting

Lead with the answer to the question asked, then the evidence: quote the words, and cite `<session-id-prefix> <timestamp>` after each. Group by decision rather than by session.

Say plainly what the search did not find — an absence you looked for is a finding, and it is what keeps the same question from being asked again. Where a decision lives in a transcript but not in the repo, name the gap and what would close it.

## See also

- `search-sessions` — the same recovery by grep, for a machine with no database
- `handoff` — write the next session's brief, so a decision does not need excavating
- `git` — find the commit or branch a transcript names

## Red flags

- Grepping `~/.claude/projects` when `dim q search` answers in a fraction of the time
- Paraphrasing a decision instead of quoting it
- Quoting a hit without the session id and timestamp that let someone else find it
- Treating a matched line as the decision without reading the exchange around it
- Searching only the user's messages, when the decision was stated in the reply
- Reading an empty result as "it never happened" without saying which window was searched
- Comparing two versions of a skill on a `stopped` count when each was loaded a handful of times
- Reporting a decision as recorded without checking whether the artifact exists on the current branch

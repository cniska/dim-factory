---
name: df-delegate
description: Decide whether work leaves this session for a subagent, scope what it is asked for, and check what it returns. Use before spawning an agent or handing work to a peer.
argument-hint: "<task>"
---

# Delegate

A subagent buys one thing: it reads in its own context and returns a conclusion in yours. Run `dim q tools` and read the `Agent` row — the result that reaches the parent is about a kilobyte, while the transcript behind it is the subagent's own and never arrives (`dim q running` says so in its footer). That is the entire trade. You gain context; you lose the evidence.

The failure mode is not the tool erroring. `dim q tools` puts `Agent` among the lowest failure rates of any tool on this machine. What fails is a confident conclusion nobody checked.

Most spawning here is ungoverned: `dim q delegation` splits spawns by the skill that was loaded, and the largest row is `(no skill)`. This skill is the gate on that row.

## When it leaves the session

Delegate when all three hold:

- The answer is a **conclusion**, not the material — "which file defines the retry policy", not "show me the retry code".
- You can **check it cheaply** once it arrives: a path to open, a symbol to grep, a command to rerun.
- Reading it yourself would cost context you still need for the work that follows.

Keep it in this session when any of these hold:

- You need the evidence itself, and will re-read the files the subagent read anyway.
- You already know the file or symbol. A direct read beats a spawn.
- The conclusion decides something expensive to reverse. Delegate the search, never the decision.
- You have already delegated this search. Wait for it rather than running it twice.

## Workflow

1. **Name the conclusion first.** Write the sentence you want back before writing the prompt. If you cannot, the task is not ready to delegate — it is still exploration, and exploration belongs where its findings can be read.
2. **Scope the prompt to that sentence**, and say what it must cite: `file:line` for code, a pinned revision otherwise. A prompt that describes a topic gets a file dump; a prompt that names a question gets an answer.
3. **Run independent searches concurrently** — one message, several calls. Sequential spawns for unrelated questions waste the isolation you paid for.
4. **Check the claim against the source before acting on it.** Open the `file:line` it cites. A subagent that names no source has reported a guess, and the fix is to verify it yourself, not to spawn another.
5. **Report the conclusion, not the journey.** The subagent's output is not the user's; relay what changes the decision.

## What the database can tell you

- `dim q delegation` — spawns and peer messages by the skill that handed the work over. Its `subagents` and `subagent_output` columns count every child of a session that skill delegated in, not the children of one call, so read them as scale, never as a per-call cost.
- `dim q running` — sessions and subagents active now, and what each is doing. Use it before spawning a duplicate.
- `dim q tools` — the `Agent` row: calls, failures, and the size of what comes back.

Queries cover the last 30 days by default and print the window above the rows; pass `--since <n>d`, `--since YYYY-MM-DD` or `--all` to move it.

## See also

- `df-sessions` — recover what a past session decided, instead of spawning an agent to rediscover it
- `second-opinion` — when the point is a different model's judgement, not isolated context
- `review` — the heaviest delegator on this machine, and where scoping pays most

## Red flags

- Spawning to read a file you could open, or one you have already read
- A prompt that names a topic instead of the question it must answer
- Acting on a finding whose cited source you never opened
- Running a search yourself after delegating the same search
- Sequential spawns for questions that do not depend on each other
- Delegating the decision rather than the search behind it
- Relaying a subagent's report to the user as its own output
- Reading `subagent_output` as the cost of a single spawn

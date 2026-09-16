# Findings

What the corpus said when it was first asked, on 2026-09-16, and what each number can carry. Measurements here are dated on purpose: they describe a corpus of 977 sessions, 245k messages and 31.5k commits at one moment, and they go stale. The rules they argue for belong in `design.md`; the numbers stay here.

## The stations run a fifth of the work

82% of file edits carry no `attribution_skill`. `build` carries 3.8%, `git` 2.6%, `review` 2.5%. The attribution is Claude Code's own, recorded per tool call, not something derived here, so "no skill" means the tool recorded no station.

Work done outside a station is also the work that gets fixed: 18.9% of those files drew a later `fix:` commit, against 7.4% for files edited under `build`.

Two consequences. A rule written into `build/SKILL.md` reaches 3.8% of edits and the same rule in `AGENTS.md` or `CLAUDE.md` reaches all of them, so the guidance files are where a rule earns the most. And improving a station cannot move a line that most work never enters — the reachable problem is routing, not station quality.

## A rule can be missing rather than ignored

The owner typed "hack", "workaround" or "band-aid" at the agent 65 times across 29 sessions. The distribution is not flat: 51 of them fall in February and March, one in April, one in August, and 12 on 2026-09-15.

Every one of those 12 came from Codex, working in `apps`, and one of them reads "no hacks i thought i said". The rule they restate exists, in `~/.claude/CLAUDE.md`: *no band-aid, workaround or hack*. `~/.codex/AGENTS.md` contains a single import line and no conventions, and `apps/AGENTS.md` names none of those words.

So the rule was never delivered to the tool that was breaking it. A phrase the owner repeats is first a question about where the rule lives, and only then about whether the agent obeys it.

## Delegating has cost nothing measurable

Sessions that spawned at least one subagent, against sessions that spawned none, over almost the same volume of work — 2,734 files against 2,721:

| | delegated | no delegation |
|---|---|---|
| stops per file edited | 0.32 | 0.29 |
| tool calls that failed | 3.2% | 3.3% |
| files revisited while the user was pushing back | 14.0% | 15.9% |

On the measure closest to *I had to fight the agent*, delegating is slightly better. What this cannot say is anything about delegated **builds**: `build` has handed work to a subagent 5 times in the whole corpus, so the arms above are overwhelmingly `review`, which fans out 140 times.

Every figure here counts friction the owner noticed and acted on. Work that was wrong and accepted looks identical to work that was right.

## Review already finds nothing, most of the time

Of 127 sessions that loaded `review`, 91 made no edit under `review` attribution and 36 did, touching 135 files. A review that only verifies is the outcome 72% of the time.

This counts findings *fixed during* the review. One reported and fixed later reads as clean, so 28% is a floor, not a rate.

## Codex is nudged nine times as often

Counting short typed prompts that are pure continuation — go, go ahead, do it, continue, keep going — per 100 assistant messages, over every root session that has an assistant message:

| tool | sessions | assistant messages | nudges | per 100 |
|---|---|---|---|---|
| claude | 325 | 82,927 | 278 | 0.34 |
| codex | 197 | 32,731 | 1,041 | 3.18 |

The work differs between the tools and `apps` dominates the Codex side, so this is not a controlled comparison. The direction is safe in one respect: Claude collapses a reply's content blocks into one message row while Codex writes one row per message, which inflates the Codex denominator and makes the gap conservative.

## A skill's versions are arms of one

`handoff` has 132 versions in the corpus and 121 of them were loaded in a single session; `review` has 71 versions across 253 loads. Comparing two versions of a skill on any outcome is comparing samples of one.

The same shape governs the rules files: `acolyte/AGENTS.md` has 84 versions since February. A sound comparison needs a rule that survived many sessions against its absence, never version *n* against *n+1*.

## What the instrument had to infer

Each of these is a fact the harness knows and does not write down, so the database reconstructs it. They are the list of things a harness under the owner's control should emit directly, at which point the reconstruction can be deleted.

| Fact | How it is recovered now |
|---|---|
| A session ended, and why | A hook writes to a spool, because a transcript has no end marker. The one table `rebuild` cannot restore. |
| A prompt was typed rather than injected | Claude marks it; Codex does not, so a regex over the content shape separates a typed prompt from an injected rules block. |
| A command failed | Codex records an exit code, Claude does not, so a Claude failure is only what the transcript marked. |
| A turn's duration and how it ended | Claude records no turn status; Codex rollouts before roughly March 2026 carry no `started_at`. |
| Which version of a rules file was in force | Recovered from `git log` where the file is in a repo, and only from the first sync that saw it where it is not. |
| Which skills exist for a tool | Two directories with two conventions, so the skill is linked into both. |

## What no query here can answer

Everything above except the fix-commit join measures process — what was said, loaded, called, stopped. Process cannot say whether the code was right.

The one outcome signal is the repo's own: 4,880 `fix:` commits of 22,936, written at the time by whoever had to come back. It carries real limits. A fix may land on code the session never wrote. Work nobody came back to may still be wrong. A fix committed without the conventional prefix is invisible. And a fix inside the session that wrote the file is ordinary iteration, not a defect — counting those rated `simplify` worst of every skill at 53%, with a mean lag of seven hours, which measured how busy the file was rather than how wrong it was.

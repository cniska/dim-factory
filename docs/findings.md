# Findings

What the corpus said when it was first asked, on 2026-09-16, and what each number can carry. Measurements here are dated on purpose: they describe a corpus of 977 sessions, 245k messages and 31.5k commits at one moment, and they go stale. A section asked later carries its own date. The rules they argue for belong in `design.md`; the numbers stay here.

## The stations run a fifth of the work

82% of file edits carry no `attribution_skill`. `build` carries 3.8%, `git` 2.6%, `review` 2.5%. The attribution is Claude Code's own, recorded per tool call, not something derived here, so "no skill" means the tool recorded no station.

Work done outside a station is also the work that gets fixed: 18.9% of those files drew a later `fix:` commit, against 7.4% for files edited under `build`.

Two consequences. A rule written into `build/SKILL.md` reaches 3.8% of edits and the same rule in `AGENTS.md` or `CLAUDE.md` reaches all of them, so the guidance files are where a rule earns the most. And improving a station cannot move a line that most work never enters — the reachable problem is routing, not station quality.

## A rule can be missing rather than ignored

The owner typed "hack", "workaround" or "band-aid" at the agent 65 times across 29 sessions. The distribution is not flat: 51 of them fall in February and March, one in April, one in August, and 12 on 2026-09-15.

Every one of those 12 came from Codex, working in one repo, and one of them reads "no hacks i thought i said". The rule they restate exists, in `~/.claude/CLAUDE.md`: *no band-aid, workaround or hack*. `~/.codex/AGENTS.md` contains a single import line and no conventions, and that repo's own `AGENTS.md` names none of those words.

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

Asked again on 2026-09-17 against the fix-commit outcome rather than friction, the same split gives 16.7% of files coming back for the 140 sessions that fanned out and 19.3% for the 120 that did not, over 2,748 and 2,790 files. It points the same way and it settles nothing. Files cluster hard inside a session, so the effective sample is the sessions rather than the files, and at that size the gap is noise.

The deeper problem is that the arms are not fan-out and its absence. Fan-out is what `review` does and what `build` does not, so this compares review-shaped sessions against build-shaped ones. Whether fanning out helps is answerable only where the same task is run both ways, which is an assignment the corpus never made.

## Review already finds nothing, most of the time

Of 127 sessions that loaded `review`, 91 made no edit under `review` attribution and 36 did, touching 135 files. A review that only verifies is the outcome 72% of the time.

This counts findings *fixed during* the review. One reported and fixed later reads as clean, so 28% is a floor, not a rate.

## Codex is nudged nine times as often

Counting short typed prompts that are pure continuation — go, go ahead, do it, continue, keep going — per 100 assistant messages, over every root session that has an assistant message:

| tool | sessions | assistant messages | nudges | per 100 |
|---|---|---|---|---|
| claude | 325 | 82,927 | 278 | 0.34 |
| codex | 197 | 32,731 | 1,041 | 3.18 |

The work differs between the tools and one repo dominates the Codex side, so this is not a controlled comparison. The direction is safe in one respect: Claude collapses a reply's content blocks into one message row while Codex writes one row per message, which inflates the Codex denominator and makes the gap conservative.

## A skill's versions are arms of one

`handoff` has 132 versions in the corpus and 121 of them were loaded in a single session; `review` has 71 versions across 253 loads. Comparing two versions of a skill on any outcome is comparing samples of one.

The same shape governs the rules files: `acolyte/AGENTS.md` has 84 versions since February. A sound comparison needs a rule that survived many sessions against its absence, never version *n* against *n+1*.

## The repetition an n-gram counter cannot see

Asked 2026-09-17. `q repeats` counts four-word phrases seen in three or more sessions, and its top rows are conversational — "what do you think" in 54 sessions, "if all looks good" in 54. The corrections it is meant to surface are not there.

One correction is in the corpus at least six times across 29 sessions, and `q repeats` shows none of them:

| | |
|---|---|
| 2026-08-12 | stop adding unnecessary comments |
| 2026-09-02 | why are you **again** adding unnecessary comments |
| 2026-09-02 | for the love of god dont add unnecessary comments |
| 2026-09-04 | why are you **again** adding comments that are not house style |

They share no four-word phrase, so an exact-phrase counter cannot group them however many times they are typed, and two of them say "again" — the owner had already noticed. The rule they restate is in `~/.claude/CLAUDE.md` and was resident in every one of those sessions, so this is not the delivery failure that [the band-aid finding](#a-rule-can-be-missing-rather-than-ignored) was. A resident rule was read and broken anyway, which points at the mechanical lever rather than the delivery one ([`goals.md`](goals.md) §1).

What would see it is meaning rather than phrases, which is what `embedding` now holds — except that `correction_label` has no rows, so the one source that would carry these is empty. Nothing labels itself, by design; until a reader labels them, this repetition stays invisible to every query here.

## The same script, five times, already drifted

Asked 2026-09-17, over two of the owner's product lines. Six tooling files exist under both by the same path. Five are readable on disk, and every one of them has diverged:

| file | line A | line B |
|---|---|---|
| `.githooks/pre-push` | 42 lines | 58 |
| `scripts/check-commit-message.sh` | 46 | 48 |
| `scripts/check-commits.sh` | 40 | 32 |
| `scripts/worktree-setup.sh` | 95 | 21 |
| `scripts/ship-ios.sh` | 11 | 11, differing |

Three of those jobs already exist here once: the commit-subject gate (`dim install-commit-gate`), the range check behind it (`dim check-commits`), and worktree setup (`wt`). So the per-repo copies are not the shared version of anything — they are five forks of three rules, and the divergence is what a copy does rather than a risk it runs.

`mise.toml` is in five primary checkouts, this repo among them. The count is the argument: a third project porting the same toolchain and env handling is where copying stops being cheaper than extracting.

This says nothing about which version is right. Divergence is evidence of drift, not of a defect, and two repos can legitimately need different pre-push checks — the question it forces is whether the difference was decided or accumulated.

## The tooling chain is already in the record

Asked 2026-09-17. Every session's shell commands are stored, so which CLIs a repo is worked with is a query rather than a detection:

| repo | wrangler | vercel | gh |
|---|---|---|---|
| line A | 0 | 633 | 757 |
| line B | 0 | 49 | 484 |
| line C | 109 | 0 | 13 |
| line D | 0 | 46 | 17 |
| `dim-factory` | 0 | 0 | 27 |

2,217 calls across roughly 270 sessions, collected with no network and no credential because it is read from the transcript. The chains are distinct per repo: one line deploys with wrangler and three with vercel, while `gh` is used in every one of them — so a per-repo answer is the only useful one.

What this supports is deriving a repo's tooling from what was actually run there, which no config-file heuristic can do. What it cannot say is whether a command succeeded in the world — `is_error` is what the tool recorded in the session, so a deploy that failed ten minutes later reads as a success here.

## Ranking by meaning, on the first pass

Asked 2026-09-17, over 5,856 distilled passages — 240 handoff nexts, 5,616 commit subjects, no labeled corrections. A cold `dim q search` answers in 276ms.

Quality is uneven and unmeasured. "the commit subject gate and the rule it holds" returns the right commit at 0.677 followed by four related ones; "reaching a session without anyone asking for it" matches the word *session* and misses `wake` entirely, with every score inside 0.41–0.47. A narrow score band on a bad query is the shape to distrust.

Two structural reasons, both known before measuring: commit subjects outnumber nexts more than twenty to one, and a one-line subject against a paragraph-long question is a length mismatch the model was not trained for. Neither is evidence against the approach, because no benchmark is wired up yet — nothing here says this ranking beats the keyword one it replaced, which is why [`recall.md`](recall.md) claims nothing.

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

## Effort does not grade the work

Asked on 2026-09-17. Of 260 sessions that edited at least three files, split by whether a later `fix:` commit touched a file they edited:

| | sessions | turns per file | pushback per file | shell calls per file |
|---|---|---|---|---|
| work came back | 134 | 1.25 | 0.29 | 8.9 |
| work held | 126 | 1.89 | 0.52 | 13.3 |

Work that held took half again as many turns per file, drew more pushback, and ran more commands. Raw turn count does not separate the two either — 24.3 against 19.6 — and that gap is size: the sessions whose work came back touched 24.6 files against 17.8, so turns rose by less than the work did.

A grade rewarding fewer turns therefore rewards the profile that correlates with work coming back, and the cheapest way to win it is to stop early. The direction is the finding; the magnitude is not, because a file nobody returned to reads as held whether it was right or abandoned.

## A fix rate grades the month, not the station

Asked on 2026-09-17. Share of files edited under each station that drew a later `fix:` commit, counted per month and shown where a month carried at least 25 files:

| station | 2026-08 | 2026-09 |
|---|---|---|
| build | 7.3% (150 files) | 30.7% (75) |
| review | 5.4% (74) | 25.7% (70) |
| (no station) | 13.5% (1543) | 24.2% (2020) |

Every row rises steeply, `(no station)` included, so what moved is not station quality. The months hold different work: feature repos in August, high-churn work on this instrument in September, where a fix lands on a file within hours of it being written.

Inside August the separation is real — 7.3% and 5.4% against 13.5% for unstationed work. Inside September it is gone, on 70 to 75 files a row. So a station grade computed this way tracks what was being worked on, and a loop that optimizes it chases the project mix. Deciding whether a station improved needs a controlled arm, not a rate read off the corpus.

## A word list cannot find a narrating comment

Asked on 2026-09-17. The conventions forbid a comment that narrates the change rather than stating the constraint that forced it, and the obvious gate is a word list. Matching `used to`, `no longer`, `previously`, `formerly`, `instead of`, `now `, `renamed` and `was removed` against comment lines in `src/*.ts` and `skills/*/SKILL.md` returned 12 lines, and every one of them was legitimate: "scratch trees that no longer exist", "shown instead of an empty table", "Renamed, never deleted".

The words that mark narration are the same words that describe final state, so precision is zero here and a gate built on them would reject only correct comments. A check that cries wolf is ignored, which costs more than no check.

What the class needs is a reader, which is why a judgement check is an agent with a fixed brief rather than a pattern. The mechanical half of the same convention — a banner comment, a comment longer than two lines — is still gateable, because those are shapes rather than meanings.

## What no query here can answer

Everything above except the fix-commit join measures process — what was said, loaded, called, stopped. Process cannot say whether the code was right.

The one outcome signal is the repo's own: 4,880 `fix:` commits of 22,936, written at the time by whoever had to come back. It carries real limits. A fix may land on code the session never wrote. Work nobody came back to may still be wrong. A fix committed without the conventional prefix is invisible. And a fix inside the session that wrote the file is ordinary iteration, not a defect — counting those rated `simplify` worst of every skill at 53%, with a mean lag of seven hours, which measured how busy the file was rather than how wrong it was.

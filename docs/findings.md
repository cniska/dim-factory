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

## A checker catches what a word list cannot

Asked on 2026-09-17, as a planted-defect test of the check step both stations carry. Three comment defects were written into one slice and the checking agent was told nothing about them: a paragraph narrating the change ("previously", "Now", "which is better"), and two comments restating the line below them. It found all three, quoted each, and named the rule each broke. It also found a fourth the author had written and forgotten.

More usefully it found a defect nobody planted. The trace writer opened the database with a bare connection, which does not run `SCHEMA_SQL`, so on any database written before that table existed every insert raised `no such table` and the surrounding catch dropped it. Confirmed by running the command and reading back zero rows: the feature was dead and silent. A word list finds none of this, and neither does a test that was never written.

What it cost: one agent, 12 tool calls, about 90 seconds, against a slice of five files.

It did it again on the `pre-push` gate the same day, against a slice its author believed finished and had 250 green tests behind. The hook waved a push through whenever the remote's tip was an object the checkout did not hold, on the reasoning that an oid it cannot resolve is something it cannot establish. That is backwards: the tip is missing locally exactly when it is a commit this checkout never fetched, which is the force push that loses someone else's work rather than the one that cannot be judged. The checker reproduced it end to end with two clones, and the reproduction is now a test. It also caught two tests asserting on the hook's source text rather than its behavior, which passed while the rule they named was intact and would have reddened on a rewrite that changed nothing.

Neither of those is a defect a second pair of eyes would obviously catch either. What the checker had that the author did not was no stake in the slice being done — the run cost 19 tool calls and about four minutes.

## The record already says which queries are used

Asked on 2026-09-17. Every `dim q` an agent runs is a shell call in a transcript, so usage needs no instrumentation: `search` 30 runs, `thread` 14, `prior-art` 9, `skills` 8, `resume` 8, down to `chain` at 4. That is what retired two shipped skills on the same day — `df-delegate` had never loaded once.

What the transcripts cannot hold is which branch inside a command answered, because `q search` falling back from cosine to the keyword index produces the same shape of rows either way, and any command run from a terminal belongs to no session at all. That gap is what `command_trace` exists for, and it is the whole of what it adds.

## `prior-art` matches a path, not a meaning

Asked on 2026-09-17. `dim q prior-art "lexer"` returns nothing across all 22 indexed repos, while `acolyte/src/log-parser.ts` sits on disk and does the job. `prior-art` reads `repo_file`, so it answers whether a file's **path** looks like the fragment — which worked directly for `workspace-contract` — and is blind to a concept whose file is named for its domain instead.

Nothing here indexes code by meaning. `q search` is semantic but covers only the text a person distilled: handoff Nexts, commit subjects, labeled corrections. So "have we written one of these before" is answerable when the concept names its own file and unanswerable otherwise.

## What held in one session, and what did not

Observed across a single long session on 2026-09-17, so this is an anecdote about one agent and not a corpus measurement; it is recorded because it points the same way as every arm above.

Instructions did not hold. The comment convention was in force the whole time, in `~/.claude/CLAUDE.md` and then in this repo's own `AGENTS.md`, and the same agent broke it three times and was corrected by hand each time. The station's own instruction to check a slice before committing it was skipped on two of the slices that followed it.

Gates held every time. The `commit-msg` hook refused two subjects at 52 and 53 characters. The `pre-commit` hook refused its first real commit and was right to: the check passed standalone and failed inside the hook, because git exports `GIT_DIR` and `GIT_INDEX_FILE` and the worktree suite inherited the committing repo's index.

The asymmetry is not about effort or attention. A gate does not require anything to have been read.

## What no query here can answer

Everything above except the fix-commit join measures process — what was said, loaded, called, stopped. Process cannot say whether the code was right.

The one outcome signal is the repo's own: 4,880 `fix:` commits of 22,936, written at the time by whoever had to come back. It carries real limits. A fix may land on code the session never wrote. Work nobody came back to may still be wrong. A fix committed without the conventional prefix is invisible. And a fix inside the session that wrote the file is ordinary iteration, not a defect — counting those rated `simplify` worst of every skill at 53%, with a mean lag of seven hours, which measured how busy the file was rather than how wrong it was.

## Git is the most-run tool and the least-guided one

Asked on 2026-09-17, over the whole corpus. Git is the busiest thing an agent does here: 3,655 `commit` operations, 3,418 `add`, 656 `push`, and 1,474 operations that destroy work if aimed wrong — 503 worktree discards, 294 `branch -D`, 242 `reset --hard`, 207 amends, 72 force pushes. `reset --hard` fails at 23% against a roughly 4% baseline for git calls generally.

The guidance for it loads about a third of the time. Of 333 sessions that committed, 114 had the `git` skill in context; of 153 that ran a destructive operation, 48 did. The skill is not unused — 244 loads across 121 sessions puts it among the most-loaded — and it is still absent from two thirds of the sessions doing the work it covers.

What that costs is visible in one rule. `~/.claude/skills/git/SKILL.md` states "Never use `git -C <path>`"; `git -C` was run 1,250 times. Some of those are worktree sessions where a bare `git` is refused, so the count is an upper bound on violations rather than a tally of them, but no reading of it makes the rule effective.

The same file tells the agent to read `git log` for a repo's convention. The record already holds the answer: `hoodly-hq/hoodly` is 100% conventional at 43 characters mean, `cniska/apps` 100% at 39 with nothing over 50, `cniska/acolyte` 100% at 48 with 44% over 50. That is a row to read, not a log to infer from.

## The push gate is off in every repo that was created rather than cloned

Found on 2026-09-17, by tracing a fresh repo rather than reading the hook. `pre-push` learns which branch is shared from `refs/remotes/<remote>/HEAD`, and exits 0 where that ref is absent, having nothing to protect. `git clone` sets it. `git init` followed by `git remote add` and `git push -u` never does — verified end to end on a scratch repo, where the ref came back `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` after a successful first push.

Three checkouts on this machine are in that state, `dim-factory` among them, so the gate written here on the day it was written was never armed in the repo that holds it. `git remote set-head origin -a` sets the ref and arms it.

A hook cannot guess its way out of this. Nothing local says which branch is the shared one: the upstream of the branch being pushed is set by the first `push -u` on a topic branch too, and `init.defaultBranch` is a setting about new repos rather than a statement about this remote. So the gap is reported rather than papered over, which is what `dim doctor` is for.

## There is no single convention to take

Asked on 2026-09-17, from `dim q convention` over the owner's own repos. All of them are 100% Conventional Commits, and they agree on nothing else: mean subject length runs 36 to 54 characters, the share over fifty runs 0% in `cniska/apps` to 61% in `cniska/acolyte`, and the share carrying a squash merge's `(#N)` suffix runs 0% to 11%.

So "follow the repo's convention" and "hold one rule everywhere" are different instructions here, not two names for the same one, and the subject gate already chose: `SUBJECT_LIMIT` is `cniska/apps`' rule, applied to every repo the owner owns, and `cniska/acolyte` breaks it in three subjects out of five. What makes that defensible is the ownership check rather than the choice of fifty — the gate is opinionated exactly where the opinion is the owner's to hold, and silent everywhere else.

Whether the gate moved behavior is not yet answerable. It was installed partway through 2026-09-16, and no query here can separate the commits of that day that preceded it from those that followed.

## Git aimed away from the session's own directory fails three times as often

Asked on 2026-09-17. A third of the shell calls that run git move somewhere first: of 23,309, some 6,411 open with `cd` and 1,135 redirect with `git -C`. Where the target is an absolute path the session's `cwd` can be compared against, 3,816 of those calls stayed inside it and failed at 3.2%, while 539 aimed outside it, across 79 sessions, and failed at 10%.

The comparison is only as good as the paths it can parse — a relative `cd`, a shell variable, or a `pushd` is not in either column — so the counts are a floor and the rates describe the calls that named an absolute path. What they do not describe is damage: a failed call is a call git refused, and a command that ran against the wrong repo successfully looks like any other row here.

The channel that could hold this is not the one the commit gates use. A `commit-msg` or `pre-push` hook knows the repo it is running in and nothing about which repo the session was supposed to be in, so the check belongs to a `PreToolUse` hook on `Bash`, which dim does not install yet.

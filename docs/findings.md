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

Two structural reasons, both known before measuring: commit subjects outnumber nexts more than twenty to one, and a one-line subject against a paragraph-long question is a length mismatch the model was not trained for. Neither was evidence against the approach at the time, because nothing was scored. What scoring it later showed is below, under "Meaning is found where the words already match".

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

## A reviewer catches what a word list cannot

Asked on 2026-09-17, as a planted-defect test of the check step both stations carry. Three comment defects were written into one slice and the checking agent was told nothing about them: a paragraph narrating the change ("previously", "Now", "which is better"), and two comments restating the line below them. It found all three, quoted each, and named the rule each broke. It also found a fourth the author had written and forgotten.

More usefully it found a defect nobody planted. The trace writer opened the database with a bare connection, which does not run `SCHEMA_SQL`, so on any database written before that table existed every insert raised `no such table` and the surrounding catch dropped it. Confirmed by running the command and reading back zero rows: the feature was dead and silent. A word list finds none of this, and neither does a test that was never written.

What it cost: one agent, 12 tool calls, about 90 seconds, against a slice of five files.

It did it again on the `pre-push` gate the same day, against a slice its author believed finished and had 250 green tests behind. The hook waved a push through whenever the remote's tip was an object the checkout did not hold, on the reasoning that an oid it cannot resolve is something it cannot establish. That is backwards: the tip is missing locally exactly when it is a commit this checkout never fetched, which is the force push that loses someone else's work rather than the one that cannot be judged. The reviewer reproduced it end to end with two clones, and the reproduction is now a test. It also caught two tests asserting on the hook's source text rather than its behavior, which passed while the rule they named was intact and would have reddened on a rewrite that changed nothing.

Neither of those is a defect a second pair of eyes would obviously catch either. What the reviewer had that the author did not was no stake in the slice being done — the run cost 19 tool calls and about four minutes.

## The record already says which queries are used

Asked on 2026-09-17. Every `dim q` an agent runs is a shell call in a transcript, so usage needs no instrumentation: `search` 30 runs, `thread` 14, `prior-art` 9, `skills` 8, `resume` 8, down to `chain` at 4. That is what retired two shipped skills on the same day — `df-delegate` had never loaded once.

What the transcripts cannot hold is which branch inside a command answered, because `q search` falling back from cosine to the keyword index produces the same shape of rows either way, and any command run from a terminal belongs to no session at all. That gap is what `command_trace` exists for, and it is the whole of what it adds.

## `prior-art` matches a path, not a meaning

Asked on 2026-09-17. `dim q prior-art "lexer"` returns nothing across all 22 indexed repos, while `acolyte/src/log-parser.ts` sits on disk and does the job. `prior-art` reads `repo_file`, so it answers whether a file's **path** looks like the fragment — which worked directly for `workspace-contract` — and is blind to a concept whose file is named for its domain instead.

Nothing here indexes code by meaning. `q search` is semantic but covers only the text a person distilled: handoff Nexts, commit subjects, labeled corrections. So "have we written one of these before" is answerable when the concept names its own file and unanswerable otherwise.

## The record cannot point at the repo's own docs

Observed on 2026-09-17, so this is an anecdote about one agent. An agent extending the landscape survey ran a fresh web sweep and brought back four items that were already written down — three in [`landscape.md`](landscape.md) and one in [`build-order.md`](build-order.md) — and found that out only by reading the doc afterwards.

`q search` could not have redirected it. The embedding index that day held 242 handoff nexts and 5,558 commit subjects and no doc text, so a question whose answer is a paragraph under `docs/` ranks against whatever commit subject is nearest and comes back looking like an absence. A subject records that a doc changed, never what it now says.

That is [the path-not-meaning limit](#prior-art-matches-a-path-not-a-meaning) reaching the agent least able to notice it: the one whose whole task is finding out what is already known, and whose failure mode is confidently re-deriving it.

## What held in one session, and what did not

Observed across a single long session on 2026-09-17, so this is an anecdote about one agent and not a corpus measurement; it is recorded because it points the same way as every arm above.

Instructions did not hold. The comment convention was in force the whole time, in `~/.claude/CLAUDE.md` and then in this repo's own `AGENTS.md`, and the same agent broke it three times and was corrected by hand each time. The station's own instruction to check a slice before committing it was skipped on two of the slices that followed it.

Gates held every time. The `commit-msg` hook refused two subjects at 52 and 53 characters. The `pre-commit` hook refused its first real commit and was right to: the check passed standalone and failed inside the hook, because git exports `GIT_DIR` and `GIT_INDEX_FILE` and the worktree suite inherited the committing repo's index.

The asymmetry is not about effort or attention. A gate does not require anything to have been read.

## What no query here can answer

Everything above except the fix-commit join measures process — what was said, loaded, called, stopped. Process cannot say whether the code was right.

The one outcome signal is the repo's own: 4,880 `fix:` commits of 22,936, written at the time by whoever had to come back. It carries real limits. A fix may land on code the session never wrote. Work nobody came back to may still be wrong. A fix committed without the conventional prefix is invisible. And a fix inside the session that wrote the file is ordinary iteration, not a defect — counting those rated `simplify` worst of every skill at 53%, with a mean lag of seven hours, which measured how busy the file was rather than how wrong it was.

## The workflow the factory copies was never written down

Asked on 2026-09-20, to settle what the factory's line should be from what the owner actually does rather than from either party's description of it.

`dim q search` cannot answer it. Asked for how work is designed, built and reviewed here, the closest distilled passages score 0.45 and below and are all commit subjects about unrelated builds. The index holds text a person distilled — a handoff's Next, an authored subject, a labeled correction — so a practice followed daily and never written down is absent from it. The owner wrote it down the same day, from the same corpus, and [`workflow.md`](workflow.md) is where it lives; the numbers below are what the record could say on its own.

What the loads and delegations do show, since 2026-08-21:

- **Review is the fan-out, and it is wide.** `review` carries 186 loads across 91 sessions with 153 subagents and 103 handoffs, more delegation than any other skill. It splits into a dimension per agent: correctness 57 loads, test 56, architecture 51, doc 47, security 44, style 39. Not every review runs every dimension.
- **A second model is asked for in prose, never by name.** `second-opinion` shows 40 loads across 20 sessions and **zero** typed by the user — the model reaches for it every time. The owner's own words are short and repeated: "ask fable to design?", "reframe again for fable?", "this is simpler right? yes reframe for fable", "what did fable suggest?". At 58 subagents over 20 sessions it averages near three agents a session, so a design is argued in rounds rather than fetched once.
- **The second model's claims are checked, not taken.** The same sessions carry "Verified Fable's keystone claim myself" and "I was wrong and Fable caught it" in both directions.
- **Planning as a station barely exists.** `plan` has 14 loads across 7 sessions against `spec` at 82, so what gets written down is the artifact and not the act.
- **The handoff is the most-run step of all** — 369 loads across 157 sessions, 127 of them typed by the owner, more than any other skill by a wide margin. Any line copied from this workflow that stops at review has left out its most frequent step.

What these carry: loads and delegation counts are the harness's own attribution per call, so they say which skill was in context and what it spawned. They do not say a review found anything, that a plan was good, or that a round changed a decision.

## Learning moved into the workflow, not out of the code

Asked on 2026-09-20, after the owner stopped doing delayed module-by-module reviews. The record supports learning in the process, but not a claim that the resulting code is always right.

The repeated failure patterns now have workflow counterparts: contract review before build, structured communication, read-only review dimensions, module-level review during each slice, simplification, and durable evidence. Those are responses to observed failures around heuristics, implicit contracts, weak tests, silent fallbacks, review debt, and undocumented decisions. The changes are visible in [`workflow.md`](workflow.md), but their presence is not proof that every agent follows them.

The review record shows what the checking loop is finding. Across 47 slices it raised 231 findings: docs 50, correctness 46, tests 42, style 17, architecture 13, and untested invariants 7 were the largest dimensions. Review answered 43 of the 50 documentation findings, 42 of 46 correctness findings, and 35 of 42 test findings by fixing or refusing them. This demonstrates an active correction loop, not a defect rate: the findings are selected by review and the corpus does not contain a controlled comparison with owner-led code inspection.

The later-fix record remains a warning against overclaiming. Since 2026-08-21, 4,918 `fix:` commits were matched against 23,242 commits; files edited under `dim-feat` later appeared in a fix commit 16 of 26 times, while files edited under `review` did so 23 of 99 times. These joins are by file path and commit convention, so they do not prove who caused a defect or whether an untouched file is correct. They do show why the factory needs independent review and outcome measurement even after the owner leaves implementation review.

What the evidence supports is narrower and more useful: the owner has converted repeated personal corrections into workflow rules and checking stations. Whether those rules reduce later fixes is the next measurement, not a conclusion this corpus can make yet.

## Git is the most-run tool and the least-guided one

Asked on 2026-09-17, over the whole corpus. Git is the busiest thing an agent does here: 3,655 `commit` operations, 3,418 `add`, 656 `push`, and 1,474 operations that destroy work if aimed wrong — 503 worktree discards, 294 `branch -D`, 242 `reset --hard`, 207 amends, 72 force pushes. `reset --hard` fails at 23% against a roughly 4% baseline for git calls generally.

The guidance for it loads about a third of the time. Of 333 sessions that committed, 114 had the `git` skill in context; of 153 that ran a destructive operation, 48 did. The skill is not unused — 244 loads across 121 sessions puts it among the most-loaded — and it is still absent from two thirds of the sessions doing the work it covers.

What that costs is visible in one rule. `~/.claude/skills/git/SKILL.md` states "Never use `git -C <path>`"; `git -C` was run 1,250 times. Some of those are worktree sessions where a bare `git` is refused, so the count is an upper bound on violations rather than a tally of them, but no reading of it makes the rule effective.

The same file tells the agent to read `git log` for a repo's convention. The record already holds the answer: of the owner's own repos one is 100% conventional at a mean of 43 characters, another 100% at 39 with nothing over fifty, a third 100% at 48 with 44% over fifty. That is a row to read, not a log to infer from.

## A hook that reads a file can be stopped by the file

Found on 2026-09-17, by a checking agent on the slice that gave `wake` a line of what the repo declares, and confirmed here three ways. The line is read from `package.json`, `mise.toml` and `Makefile` at session start, and each of those is an arbitrary path the hook opens.

A `Makefile` that is a directory throws `EISDIR` out of the read. A `Makefile` that is a FIFO blocks: a process reading one was still alive after five seconds and had to be killed. Neither file is exotic on purpose — a FIFO or a stray directory at that name is the sort of thing a build system leaves behind — and the second is the serious one, because a `SessionStart` hook that does not return is a session that does not start.

The invariant it breaks is stated in `AGENTS.md`: a hook may only ever fail on something it has read and understood. An unbounded blocking read of a path chosen by whatever is in the working directory is neither. What the hook needs is to stat before it opens, read only a regular file, and cap what it will read.

The same slice also printed a guess as a declaration. `packageManager` falls back to `npm` where no lock file names one, so a repo with a `package.json` and no lock was told `check npm run verify` on no evidence — in a block whose whole claim is that it carries what the repo says rather than what was inferred.

## The push gate is off in every repo that was created rather than cloned

Found on 2026-09-17, by tracing a fresh repo rather than reading the hook. `pre-push` learns which branch is shared from `refs/remotes/<remote>/HEAD`, and exits 0 where that ref is absent, having nothing to protect. `git clone` sets it. `git init` followed by `git remote add` and `git push -u` never does — verified end to end on a scratch repo, where the ref came back `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` after a successful first push.

Three checkouts on this machine are in that state, `dim-factory` among them, so the gate written here on the day it was written was never armed in the repo that holds it. `git remote set-head origin -a` sets the ref and arms it.

A hook cannot guess its way out of this. Nothing local says which branch is the shared one: the upstream of the branch being pushed is set by the first `push -u` on a topic branch too, and `init.defaultBranch` is a setting about new repos rather than a statement about this remote. So the gap is reported rather than papered over, which is what `dim doctor` is for.

## There is no single convention to take

Asked on 2026-09-17, from `dim q convention` over the owner's own repos. All of them are 100% Conventional Commits, and they agree on nothing else: mean subject length runs 36 to 54 characters, the share over fifty runs from 0% in one to 61% in another, and the share carrying a squash merge's `(#N)` suffix runs 0% to 11%.

So "follow the repo's convention" and "hold one rule everywhere" are different instructions here, not two names for the same one, and the subject gate already chose: `SUBJECT_LIMIT` is taken from the one repo whose subjects never break it and applied to every repo the owner owns, while the largest of the others breaks it in three subjects out of five. What makes that defensible is the ownership check rather than the choice of fifty — the gate is opinionated exactly where the opinion is the owner's to hold, and silent everywhere else.

Whether the gate moved behavior is not yet answerable. It was installed partway through 2026-09-16, and no query here can separate the commits of that day that preceded it from those that followed.

## Git aimed away from the session's own directory fails three times as often

Asked on 2026-09-17. A third of the shell calls that run git move somewhere first: of 23,309, some 6,411 open with `cd` and 1,135 redirect with `git -C`. Where the target is an absolute path the session's `cwd` can be compared against, 3,816 of those calls stayed inside it and failed at 3.2%, while 539 aimed outside it, across 79 sessions, and failed at 10%.

The comparison is only as good as the paths it can parse — a relative `cd`, a shell variable, or a `pushd` is not in either column — so the counts are a floor and the rates describe the calls that named an absolute path. What they do not describe is damage: a failed call is a call git refused, and a command that ran against the wrong repo successfully looks like any other row here.

The channel that could hold this is not the one the commit gates use. A `commit-msg` or `pre-push` hook knows the repo it is running in and nothing about which repo the session was supposed to be in, so the check belongs to a `PreToolUse` hook on `Bash`, which dim does not install yet.

## The gate's owner check named an account but not a forge

Found and fixed on 2026-09-17. The three gate hooks decided whether to arm by reading the second-to-last path segment of the remote URL, which is an account name with the host discarded. Every one of these yields the same owner:

| remote | owner it matched |
|---|---|
| `https://github.com/<account>/<repo>.git` | `<account>` |
| `https://gitlab.com/<account>/<evil>.git` | `<account>` |
| `git@evil.example.com:<account>/<evil>.git` | `<account>` |
| `/tmp/holding/<account>/<evil>.git` | `<account>` |

That matters because the `pre-commit` hook runs `eval` over whatever the repository's own manifest declares as its check. An account name is not an identity — anyone may register one on another forge, or name a directory after it — so cloning a repository that names a directory that way and committing once ran its scripts. `core.hooksPath` is global here, so the hook meets every clone on the machine and no `dim` command has to be typed.

The owner is now the whole of the URL before the repository: `github.com/<account>` for a forge, and the parent directory for a file path.

What the machine was actually exposed to, measured across the checkouts the corpus names: of 21 with an origin, 15 armed the gate, and 0 armed it that should not have. Every remote on this disk is on one host, so the defect changed nothing already here. That is the whole of what the number carries — it describes the clones that exist, not the next one, and one is enough.

What the host match cannot guard is a branch inside a repository that is genuinely the owner's. Checking out a fork's pull request puts a contributor's manifest in the tree, and the next commit runs it. That is inherent to running the repository's own check from a commit hook, and it is stated rather than closed.

## The push gate read no shared branch when the push named a URL

Found and fixed on 2026-09-17. Git's `pre-push` contract passes the remote's name as the first argument when the push names a remote, and the remote's *URL* when it does not. The gate read the branch it protects from `refs/remotes/<first argument>/HEAD`, which resolves for a name and never for a URL. The ownership check reads the second argument, which is the URL either way, so a push by URL passed ownership and then exited on an empty branch name.

The same rewrite, in a repo the owner owns, with the gate installed and armed:

```
=== force push via remote NAME ===
pre-push: this rewrites refs/heads/main on origin.
=== force push via URL ===
 + e3de6f9...d6365ff main -> main (forced update)
```

That is the push the gate exists to refuse, allowed by spelling it differently. The hook now maps the URL back to the remote configured for it before reading the ref.

Mapping it back is not a string compare, because one remote has many spellings. A first attempt compared the URL git handed the hook against `remote.<name>.url` byte for byte, and four ordinary spellings of the same remote still went through — a trailing slash, a `.` segment, a relative path, and a `file://` URL for a configured local path — while `insteadOf` broke it outright, since git hands the hook the rewritten URL and the config holds the raw one. Both sides are now reduced to one spelling first, and each remote is resolved with `git remote get-url --push`, which is what sees `insteadOf` and a separate `pushurl`.

What still passes is a URL that resolves to no configured remote. That is not a hole: the checkout has no remote-tracking ref there, so there is no shared branch to compare against, and a hook may only refuse what it has read and understood.

## A regex comment-stripper reads a URL as a comment

Found on 2026-09-17, looking for prior art before writing the JSONC reader in [`src/jsonc.ts`](../src/jsonc.ts). Another repo on this machine holds a `src/json.ts` that reads a config allowing comments by deleting them first: `//` to end of line, then `/* */`, then `JSON.parse`. The strip runs on names ending in `c`, which is what its callers pass for a `.jsonc` file and for `.prettierrc` and `.eslintrc`. Given `{"url": "https://example.com/a", "x": 1}` the stripper leaves `{"url": "https:`, because the scheme separator inside a string is the same two characters as a comment; `JSON.parse` then throws and the reader returns null. A `$schema` URL in one of those files is the live path, and the config reads back as absent rather than as broken.

A tokenizer has the state a pattern does not: `jsonc-parser` knows it is inside a string, which is the whole of the difference. The same shape appeared in the gate for narrating comments above — a pattern matching text whose context it cannot read — and it is why the reader here is a dependency rather than a hand-rolled strip.

First written on the same day with the defect stated more broadly than the code supports: the `endsWith("c")` gate was missed, and that repo pins the plain-`.json` case green in its own test. The correction came from a review dimension reading the caller, which is the check a probe of the function alone does not make.

`prior-art` found this only when the query dropped to `json`: the file is named for the format it parses rather than the dialect it accepts, so `jsonc` returned nothing on a machine holding one. That is the path-not-meaning limit measured above, hit again.

## An editor and a reader disagree about a key written twice

Measured on 2026-09-17, against `jsonc-parser` 3.3.1. Its `parse` resolves a repeated key to the **last** copy, which is what `JSON.parse` does and therefore what both tools do when they read their config. Its `findNodeAtLocation`, which every edit goes through, resolves the **first**. So a config where a key appears twice can be edited at one copy and read at another.

Left unchecked that is silent and cumulative rather than a failure: installing a hook into such a file reported success, appended into the copy nothing reads, and reported the hook missing immediately afterwards — two runs left twelve command entries in a dead object, and because the install never converged, each run's backup overwrote the last good config. The round-trip through `JSON.stringify` that this replaced collapsed duplicates and got it right, which is the shape a replacement has to be checked against rather than assumed better than.

The guard is to read the written text back the way the tools read it and refuse the write unless every command is in it. The general form: where an edit and a read go through different parsers, the only thing that establishes the edit landed is reading it back through the reader's.

## A station's fix rate grades the code it is called on

Asked on 2026-09-17. `q fixes` reports `simplify` at 47.5% — 28 of 59 files drew a later `fix:` commit — against 16.3% for `build` and 24.3% for files edited with no station attached. Read as a verdict on the station that is damning, and it is the wrong reading.

Asking the same question in both directions settles it. For every file an agent edited, whether a `fix:` commit touched it in the seven days *before* that edit, and in the seven days *after*, counting only edits with a full seven days elapsed:

| skill | files | % fixed in the 7 days before | % in the 7 days after |
|---|---|---|---|
| agents-md | 93 | 7.5 | 30.1 |
| simplify | 39 | 33.3 | 25.6 |
| (no skill) | 4031 | 13.6 | 15.7 |
| spec | 72 | 6.9 | 15.3 |
| build | 222 | 7.7 | 6.3 |
| review | 106 | 4.7 | 4.7 |

Files arrive at `simplify` already being fixed at four times the rate of files arriving at `build`, and they leave at a lower rate than they came in. Nothing here says the station makes code worse; it says it is pointed at code that was already churning, which is what a simplification station is for. The aiming is the part that works, and the record can do it deliberately rather than by intuition.

What these numbers carry: one owner, about a month, and only commits with a `fix:` prefix, matched by path so repos sharing a name collide. Before and after are not independent — a file fixed last week is likelier to be fixed next week whatever happened in between — so the drop from 33.3 to 25.6 is not evidence of improvement either. A thirty-day window was tried first and leaves `simplify` with fewer than twenty files, too few to read a rate off, because all of its use is recent; seven days is the widest window its own data supports, while `q fixes` counts a fix arriving at any later date, which is why its number is the larger one.

The row that needs explaining is `agents-md`: four times more fixes after the edit than before, on the largest station sample here. That is the shape `simplify` was accused of, and nothing has looked at it.

## The keyword index carries text nobody said

Measured on 2026-09-17, over the whole corpus. `message_fts` indexes every `message.text`, and 674 of the 1,631 rows flagged `is_meta` carry text — mostly reminders the harness injects rather than anything a participant wrote. They repeat: the most common one is identical across 295 of the 1,031 sessions on this machine, so a term inside it matches hundreds of rows that are the same row. On one real query, `local-command-caveat`, 322 of the 324 matching rows were injected text.

The flag does not mean nobody said it. 52 of those rows are marked `coordinator` in `origin_kind` and 33 `peer` — another agent's instruction or correction, relayed into a session by the harness and flagged meta for having arrived that way. A question about what was decided wants exactly those, so `origin_kind` is what separates them; excluding on `is_meta` alone drops them.

Skill bodies look like the larger problem and are not one. All 957 of them carry no text at all — the Claude parser drops the body it just recognized — and every one is flagged `is_meta` as well, so a condition naming `is_skill_body` selects nothing that `is_meta` had not already excluded. The size of a skill body is why it looks worth excluding; it was never in the index to exclude.

What this carries: one machine's corpus, all of history, and Claude only — `src/parse-codex.ts` never sets the flag, so Codex contributes no rows here because nothing marks them, not because it injects nothing. It says what the keyword path had to stop returning, not how often a search was spoiled by it — nothing counted that.

## Meaning is found where the words already match

Measured on 2026-09-17 by `dim bench` over 16 hand-labeled questions, each naming one or two commit subjects in this repo's own history that answer it. At k=10, `q search` scores **recall 0.531 and nDCG 0.472**. Seven questions return every row they should; six return none of them.

The result is bimodal rather than middling, which is the part worth acting on: retrieval here does not degrade gently, it either finds the subject or does not come near it. One case shows a word beating a paraphrase outright — "what is happening at this moment, delegates included" should find `feat: show what is running, subagents included`, every content word a synonym or the same word, and the top hits are instead `docs(plan): delegate design questions, don't escalate` and `feat(agent): delegate via main model before role execution`, which carry the word *delegate* and none of the meaning.

**What does not explain the split is word overlap.** Four of the six zero-scoring questions share content words with the subject they miss — "transcript lines the ingester could not make sense of" shares *lines* and *could not* with `fix: report the lines the parser could not read` and still scores zero — while the cleanest 1.0, "remove an out-of-date copy of another project's internals" against `docs: drop a stale snapshot of another repo`, shares almost nothing. So the failure is not "it only finds what it could have grepped", and a word signal added alongside would not obviously fix these six. What does separate them is not yet known, and guessing produced a wrong answer once already.

What this carries, and it is less than it looks. Sixteen questions, written by one agent in one sitting, every one naming a commit subject — a one-line subject against a sentence-long question is a length mismatch, and subjects outnumber handoff nexts more than twenty to one in the index. It says this ranking fails over half of a set of paraphrase questions it was built to answer. It says nothing about which change would fix that, which is the next thing to score rather than assume.

## The benchmark every ranking change waits on already exists

Found on 2026-09-17, when several pages here still deferred a retrieval decision to a benchmark they described as unbuilt. Acolyte has one — `scripts/run-memory-bench.ts` with its scenarios and metrics — scoring retrieval by recall@k and nDCG@k over LongMemEval and LoCoMo, with queries whose relevant records are known. It landed alongside that repo's hybrid scoring, so the weights there were set against measurements rather than picked.

What it did not settle, and what happened instead. It scores retrieval over distilled memory records, and the population here is messages, commit subjects and repo files, so neither the datasets nor the scenario layer carried across. The metrics were written here rather than borrowed, and the corpus was labeled by hand against this record — the two of them are a smaller job than the entry above assumed, and they are done. What the prior art still holds that this does not is the external datasets, which are what make a published claim checkable.

This was reachable only by hand. `prior-art` matches a path, `q search` ranks distilled text, and the four files that first pointed here had been renamed, which reads in the history as a deletion — the rename hazard [`design.md`](design.md) already names, met in practice.

## An ANDed phrase costs more than the one before it

Measured on 2026-09-17 against the corpus of the day, 253,570 messages with 90,163 searchable. A keyword search ANDs one FTS5 phrase per word, and the cost of the whole grows about fourfold per doubling of the term count:

| words | wall clock |
|---|---|
| 50 | 1.7s |
| 100 | 4.4s |
| 200 | 17.2s |
| 400 | 63.6s |

4,000 words — under 14KB, less than a paragraph of a transcript — took 1 hour 43 minutes, holding one core for 6,168 seconds of CPU. That is one run rather than a curve, but it is the endpoint the table above predicts. The read path sets no statement timeout and no progress handler, so nothing stops it short.

This matters because of who writes the argument. A search string reaches the query from a file or a transcript the agent is reading as readily as from a person typing, and the caller cannot see the cost before paying it. So the words past a cap are dropped and the denominator says how many, which bounds the work at the one place both readers of the index share: the same 5,000-word argument now returns in a third of a second.

What this carries: one corpus, one machine, English stopwords as the terms — the worst case, since a rare word intersects almost nothing. A query of ordinary words is faster than this table at every count.

## The any-term match costs a fraction of the intersection it replaces

Measured on 2026-09-20 against the corpus of the day, 280,092 messages with 97,605 carrying text anyone said, on the same machine as the table above. `keywords` now unions one FTS5 match per term instead of intersecting one phrase per word (`keywords-any-term`), and the per-term read is linear where the intersection was superlinear:

| terms | ordinary words | English stopwords |
|---|---|---|
| 1 | 80ms | 292ms |
| 2 | 79ms | 286ms |
| 6 | 167ms | 392ms |
| 16 | 255ms | 634ms |

Stopwords cost more than ordinary words at every count, since a term with a doclist touching most of the corpus is grouped rather than skipped — but even the 16-term worst case stays under a second, next to the AND table's 63.6s at 400 words and 1h43m at 4,000. The decision this measurement was taken against: if the 16-term worst case stayed under two seconds, `MAX_TERMS` would stay at 16 rather than drop. It stayed under two seconds, so it stays at 16.

What this carries: one corpus, one machine, sixteen ordinary words and sixteen English stopwords, each run once after a warm-up query absorbed the first-query-in-process cost SQLite pays opening the FTS5 index — a single-word query timed before any warm-up, repeated across two otherwise-identical runs, cost 1964ms and 1974ms regardless of which sixteen words followed it, so it is excluded from the table as a one-time cost rather than a per-term one. The AND table this replaces is not deleted — a caller who still ANDs a phrase by hand, or a future path that wants an intersection, has a real cost curve to read it against.

## A proof by removal can pass without proving anything

Found on 2026-09-18, checking `dim q findings`. A test claiming an invariant is proved by deleting the invariant and watching the test go red. That proof was attempted through a scripted shell edit, which silently matched nothing — the formatter had rewrapped the target line since it was read — so the deletion never happened and the suite stayed green. A green suite is the same output a removal produces when the test does not actually hold the invariant, so the two are indistinguishable from the result alone.

The edit that no-ops is the failure mode, not the editor. A file tool refuses an edit whose target has moved; a shell rewrite reports success for replacing nothing. This is the concrete case behind the rule that files are read and edited through the file tools rather than the shell, and it costs a false proof rather than a lost write.

What makes a removal proof trustworthy is reading the failure, not the exit code: the red must name the test the invariant belongs to. A removal that leaves every test passing means the invariant was never held or was never removed, and those two are told apart by looking at the file.

## The parsers generalize; the wiring around them did not

Asked on 2026-09-18, to price a third agent CLI before deciding whether to support one. `parse-claude.ts` and `parse-codex.ts` already share a shape: both take lines and a first line number, both fill the same `ParsedChunk` accumulators, and both drop an unparseable line by number rather than stalling. What differs is only what each carries in — a thread id and running state for Codex, the known skill names for Claude. So the parser boundary was never the obstacle.

The cost sat outside it. The pair was written as a literal list in four places, the `Tool` type was exported from two modules and spelled inline as a union in two more, and four tables constrained their `tool` column with the vocabulary written again in SQL — twelve places naming the same two tools, none derived from another. Missing one of them writes a row the database then refuses.

The list is now one constant, the type is declared and imported from one module, and the four constraints interpolate it. What that does not reach is a database already on disk: every constrained table is created only if absent, so its `CHECK` keeps the vocabulary it was born with. Adding a tool is therefore a schema version bump and a drop of those four tables, not an edit to the constant — the constant stops the code disagreeing with itself, and a migration is what makes the database follow.

What stays per-tool and should: the source module that finds files on disk, the parser, the hook config path, the history reader and its per-tool timestamp scale, the wake envelope, and Codex's trust check, which has no Claude equivalent. That is the real price of a third tool.

## The runtime paints stderr, and the environment can force it

Measured on 2026-09-18 against Bun 1.3.14. `console.error` wraps its whole line in `ESC[0mESC[31m` … `ESC[0m`. It does that when stderr is a pipe as readily as when it is a terminal, whenever `FORCE_COLOR` is set in the environment, and `NO_COLOR=1` does not turn it off. `console.log` is untouched, so this shows up only on the error paths.

Nothing here writes an escape of its own — the styling is entirely the runtime's, applied to text that is a contract. `scripts/wt.test.sh` compares `dim wt`'s stderr against exact strings, so under a forced-color environment four of its cases failed on the escapes alone. That is `bun run verify`, which is what the `pre-commit` hook runs, and the hook inherits the environment: every commit that ran the check was refused for a reason having nothing to do with the change.

The fix is that a diagnostic is written as bytes, through [`src/warn.ts`](../src/warn.ts), rather than through a console API that decides how it should look. What keeps it there is `noConsole` in [`biome.json`](../biome.json), which allows `console.log` and refuses the rest — the choice of stream is mechanical, so it is a gate rather than a rule to remember. The case pinning it sets `FORCE_COLOR` itself, so it holds whatever the ambient environment is — which is what a test of this has to do, since the environment that breaks it is not the one the suite usually runs in.
## Two runs really do hold the sync lock, and not on demand

Measured on 2026-09-18 against the lock as it stood before that day. Contenders run `withLock` in a loop over a scratch data directory; inside the lock each writes a marker file named for its pid, reads the directory back and removes it. A second marker in that listing is a second run inside the lock at the same time.

Two contenders, 200 rounds, six trials: 6 of the 12 processes recorded an overlap. The same harness against the lock that replaced it recorded none, over 12 processes and 1,294 acquisitions.

Making it fail on demand did not work. Four contenders at 300 rounds detected an overlap in 3 trials of 8, and two contenders at 800 rounds in 2 of 8 — once one process is ahead of the other they stop arriving together, so more rounds and more contenders both buy less. Holding every contender at a barrier until all have arrived, then releasing them together, was worst at 1 trial in 10: the window is two syscalls wide, and a contender released from a barrier still reaches the pid file after the winner has written it, which is the case the lock already refuses correctly.

What this carries. The defect was real, and the replacement is clean on the workload that exists — the scheduled agent and a person, which is two writers. It is not a test and none ships: a check that catches a planted defect in half its runs would have gone green over this one. What does have tests is the state a second run can find on disk — an empty pid file, a pid file it cannot read, a directory with no pid file at all, and what a refused run leaves behind.
## A tenth of the pushback was the harness refusing itself

Measured on 2026-09-18. `message.denial_kind` carries the tool's own word for why a call did not run, and three words appear: `user-rejected` 313, `automode-blocked` 182, `automode-unavailable` 16. Only the first is a person. The other two are auto mode declining its own call, which is the harness stopping itself and no pushback at all — the reading [`design.md`](design.md) already states, and which `corrections` and `candidates` already used while five other queries tested the column for null instead.

Over the whole corpus that is 1,905 turns counted as the owner stopping the agent where 1,707 were, so every rate built on the wider reading ran 11.6% high, and the gap grows with however much of the work runs in auto mode. One predicate now spells it, so the two readings cannot part again.

## Codex edits are invisible to every query that counts edits

Measured the same day. `tool_call.tool_name` holds each vendor's own word: Claude writes a file as `Edit` (15,635) or `Write` (2,909), Codex as `FileChange` (3,174) — a seventh of the edits in the corpus. Every query keying on the Claude pair therefore reports one tool's work under a heading that names neither, and a Codex session reads as a machine that edited nothing rather than one nothing counted. Each such query now says so; `burn` already matched all three.

A stop divides the same way and further. `denial_kind`, `interrupted_message_id` and `user_feedback` are non-null on 511, 1,394 and 54 Claude messages and on zero Codex ones, while Codex records 881 interrupted turns on `turn.status` — the same act, in a table these queries never reach. So `corrections`, `candidates` and `skill` are Claude-only on top of the edit queries. Two columns are not: `prompt_source` is `typed` on 17,174 Codex messages, so `repeats` reaches both tools for the half it draws from typed prompts, and Codex has no tool for delegation at all — its whole vocabulary is `CommandExecution`, `FileChange` and `McpToolCall`, so `Agent` and `SendMessage` match nothing because nothing happened, which is a true zero and says nothing.

Widening the rest waits on the parser. `src/parse-codex.ts` writes every path of a `FileChange` space-joined into one `file_path`, and 458 of the 3,174 rows carry more than one — so a Codex edit matches no `commit_file.path`, and the queries that join a committed path would gain rows naming a file that does not exist. `q slices` had no such join and was widened outright: it reads a commit off `git_command`, which already links 1,519 Codex `CommandExecution` calls, 401 of them commits the `Bash`-only match threw away against the 2,892 it kept.
## The temp directory a session records is not the one the rule tested

Measured on 2026-09-18. The scratch rule listed `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp` and whatever `tmpdir()` reported, normalized but not resolved. On this machine `tmpdir()` reports `/var/folders/<xx>/<yy>/T` and resolves to `/private/var/folders/<xx>/<yy>/T`, so a session started under the resolved spelling read as ordinary work. 9 session rows hold such a cwd, and `repo_commit` holds nothing from any of them — every one of those directories had already been deleted when git was asked, so the cost was a scratch repo's subjects landing in the corpus whenever one outlived a sync, not anything now in it.

The shape is the one the gate defects fixed beside it share: the check ran, reported success, and what it guarded was off. A path list, an existence test and a slug are each mechanical enough to gate, and each was wrong about a case nothing exercised. What catches that is a row from the record — the 9 above — rather than another reading of the rule.

## The check-detection word list is right by luck, and counts scratch repos as work

Measured on 2026-09-18. `q slices` reports which commits had a run of the repo's own check in front of them, and decides what a check is by matching seven substrings against the shell command — `run verify`, `run check`, `run ci`, `run validate`, `run test`, `mise run`, `make `. `dim check-task` reads the declared check from the repo's manifest and is the authority, but no table holds what it returns, so the query has nothing to join and guesses instead.

The guess is currently exact. Of the 33 checkouts under `~/code`, 21 declare a check and every one of them matches the list; the other 12 declare none. So the list produces no false negative on this machine today. It holds by coincidence rather than construction: `cargo test` and `go test ./...` match nothing, and a repo in either language would read as never checked.

The error that is live is a different one. Splitting the window's commits by where the session was working:

| | commits | with no check in front |
|---|---|---|
| real checkouts | 2,216 | 627 |
| scratch trees under `/private/tmp` | 90 | 88 |

Every one of those 90 is a fixture from an earlier session's test runs, under `.../recurrence/runs/run-N`. `isScratchRepo` exists to exclude exactly these and already lists `/private/tmp`, but it filters what `sync` ingests into `repo_commit`; `q slices` reads `tool_call` and `session.project` directly and never consults it. So a rule that is correct is applied in one place and not the other.

What this carries: one machine, one window, and a count of repos rather than of commits for the first claim — a repo declaring a check its sessions never run is invisible to that 21. The 627 is the number that survives, and it is a floor: a commit whose check ran under a name the list does not hold would still read as unchecked, and nothing here has measured how often the 12 undeclaring repos commit.

## A passage ref cut to the minute would lose one session in thirty-three

Measured on 2026-09-18 over the 242 distilled passages that come from a message — every `next` and `correction` in the index, spread across 186 sessions. 33 of those sessions hold more than one passage, which is the set a ref naming only the session cannot separate.

Cut the timestamp to the width the `when` column prints, `2026-09-01T10:30`, and one of the 33 still collides: it printed two passages inside the same minute. At seconds and at the whole stored timestamp, none of the 33 collide. So a ref cut to the minute would be right 32 times out of 33, with nothing in the output to say which session it had given up on.

What this carries is the choice of width, not a property of handoffs. Nothing constrains a session and a timestamp to name one message, so the whole timestamp is exact as measured here rather than by construction. The rate is a fact about one corpus at one size, and a corpus that grows is the case where a truncation that measured fine starts costing sessions silently.

The delimiter is the other half of the choice, and it is already taken: 525 of the 1,180 sessions have ids of the form `<agent>@<parent>`, which is how a subagent's is written, and 47 eight-character prefixes are shared by more than one session. So `@` cannot be found by splitting, and a ref is read by recognizing the timestamp's shape at the end instead. Asked for one of those sessions by its whole id, `thread` read the parent uuid as the timestamp to center on and answered with the last twelve messages — a wrong window rather than a refusal, which is the failure a delimiter chosen against an id space that already uses it produces.

## A builder explained a flaky test with a cause that cannot reach it

Measured on 2026-09-18, while three builders ran in parallel on one checkout. A builder reported `src/push-gate.test.ts` failing 6 of 16 on timeouts inside its worktree, attributed it to the rtk hook rewriting the `git` those tests spawn, and adopted `rtk proxy` for its commit on that basis.

The attribution cannot be right. Those tests reach git through `execFileSync("git", ...)` (`src/push-gate.test.ts:22`, `:26`), which spawns the binary from the test process; the hook rewrites commands issued through the agent's shell tool and never sees them. Re-run in a fresh worktree with the hook active and two builders still working, the file passed 16 of 16 on four consecutive runs.

What produced the six failures is unestablished. Load is the open candidate: `bun run verify` on the main checkout aborted with SIGABRT the same hour under the same three builders, and both of its halves passed alone immediately afterward. Neither observation isolates a cause, and one abort with one report is not a rate.

The rate, measured later the same day with one other builder working in parallel: 4 of 15 `bun run verify` runs in a fresh worktree aborted the same way, every one of them inside `bun test` and none reporting a failing test. Each re-run immediately afterward was green, three consecutive runs asked for on purpose were green, and `bun test` invoked on its own passed 516 of 516 every time it completed. So an abort says nothing about the change under it, and the cause stays unestablished — 15 runs on one afternoon with one confound cannot separate load from anything else.

What this carries is the misattribution rather than the flake. The explanation was plausible, matched a real documented caveat — rtk does break interactive `git` in a worktree — and named a mechanism that does not touch the failing code. A workaround was then adopted against it, which is the part that outlives the session: the next reader finds `rtk proxy` in a commit and infers the constraint was real. A cause is worth a check against the code it is said to act on, and a subagent's explanation is worth that check whether or not the failure it explains was real.

## A line-based read of a sample env file records a chunk of the key as a variable name

Measured on 2026-09-18, building the workspace profile's declared requirements. Reading `.env.example` line by line for names matching `[A-Za-z_][A-Za-z0-9_]*=` puts value text into the profile: a PEM body's base64 is alphanumeric and its `=` padding closes the match, so `SIGNING_KEY="-----BEGIN PRIVATE KEY-----` followed by `MIIEvQ...Kj=` yields `SIGNING_KEY` and a verbatim 64-character chunk of the key, both as names. A single-quoted value spanning lines does the same with whatever follows a `=` inside it. Following a value to its closing quote fixes it, and the fix is pinned by a test that fails when the tracking is removed.

Two things this carries. The first is that a sample file is not a safe file: it is tracked, so it is meant to hold placeholders, but the failure mode is a real value someone committed by mistake being copied into an order report — which is why no part of a value is recorded at all rather than recorded carefully. The second is that the defect was invisible to the check and to the real corpus. `bun run verify` was green over it, and the names read from the five repos on this disk that carry a sample file — 68, 4, 2, 11 and 5 — agreed exactly with `grep -c` on each file before and after the fix, because none of those five happens to contain a multi-line value. A sweep across the repos on disk says a parser works on the repos on disk, and says nothing about the input that breaks it.

## Bun parses YAML, so a hand-rolled scanner in this repo is a choice rather than a constraint

Found on 2026-09-18. `Bun.YAML.parse` is present in the Bun this repo runs and handles flow mappings, quoted keys, anchors, column-zero comments inside a block and nesting — every case a line-based scan of a compose file got wrong, including reporting an inner key such as `build` as a service name when the first service carried an anchor. `src/tasks.ts` already reads `mise.toml` through `Bun.TOML.parse` rather than scanning lines, so the precedent was there.

`pubspecFacts` in `src/workspace.ts` still scans `pubspec.yaml` line by line for its workspace members and its Flutter marker. Nothing measured says it is wrong on the pubspecs on disk, and it was left alone rather than changed under a slice that had no requirement for it; it is named here so the next reader knows the constraint that would justify it does not exist.

## A board rendering current data through stale code reads as empty, not as old

Found on 2026-09-19. The wall showed no cards while its own Done count said 12. The data was never wrong: running `assembleWallSnapshot` directly against the live database returned `totals.done = 12` and 12 cards in the same snapshot. The serving process had started 11 hours earlier, and the three commits between renamed the order statuses.

The cause is that `--dev` set Bun's `development: { hmr: true }`, which reloads the client bundle and leaves the server's module graph as it was at boot. So the half that reads the database kept the vocabulary it started with while the half that draws reloaded on every edit. Running the same command under `bun --hot` reloads both, confirmed by editing a server module against a running wall and watching the response change with no restart.

Two things this carries. A process is a place state hides, and the usual signal for stale state — a page that looks old — is absent when one half is current: the board looked broken rather than out of date, which sent the reading toward the query and the renderer, where nothing was wrong. And the message the same file printed when a second wall found the port taken said the incumbent was the fresh one and pointed the reader at it, which was exactly backwards here; a claim about which of two processes is newer cannot be made from inside either.

## A table is new in the diff long after it stopped being new in the database

Found on 2026-09-19, when `dim sync` and `dim rebuild` both stopped with `no such column: depends_on_id`. The live `queue_item_dependency` held a column named `depends_on`, from a draft of the same table earlier the same morning. The database stood at schema version 23 while the repo was at 26.

The rule that allowed it is stated at the top of `schema.ts`: a table added with nothing feeding it is not a version bump, because every write opens the database through `SCHEMA_SQL`, which creates it. That reasoning holds for exactly as long as no database has run the statement. After that the table exists, `CREATE TABLE IF NOT EXISTS` leaves it alone, and renaming one of its columns strands every database that already has the old one — the same failure the rule describes for an existing table, reached by a path the rule reads as exempt.

What closed the gap between the two states here was minutes, not releases. A wall running under `bun --hot` opens the database on reload, so a table first written at breakfast was materialized before it was committed, by a process nobody was thinking of as a writer. Newness is a property of the databases on disk and cannot be read off the diff, which is why the safe form of the rule is that a column changes with a bump whatever the table's age, and the exemption covers only the run that creates it.

## Ship read the branch to land off the caller's own checkout

Found on 2026-09-20, working `keywords-any-term`. `dim order ship` was run from the trunk checkout after that order's commit; the command printed `is fast-forwarded onto the trunk` and the trunk sat at `c5d56a8` afterward. The same command, run from the order's own worktree, landed `f014cbc`.

`shipToTrunk` (`src/ship.ts`) took the branch to land from `symbolic-ref --short HEAD` of the directory it was called with. Run from the primary checkout, that directory's own branch is the trunk, so `git merge --ff-only main` while already on `main` succeeds trivially — `git`'s own answer for "nothing to do" — and the function reported the same `fast_forward` outcome it reports for an order that genuinely landed. Nothing downstream caught it: the completion gate (`assertIntegrated`) reads the trunk independently and would have refused the order's own `stop completed`, but by then the operator already held a printed success for `ship` and a printed refusal for `stop`, with nothing saying which one to believe.

The fix threads the branch through as an argument — the order id, per the schema, never read off any `HEAD` — and, separately, re-reads every recorded sha against the trunk after the merge before reporting an outcome, rather than trusting the merge's own exit code. A command whose whole job is reporting a fact about the repository should read that fact back rather than infer it from the git command that was supposed to produce it — the same shape as the wall reading data through a stale server: the two halves that should agree came from different reads, and only one of them was watching the write actually meant to prove.

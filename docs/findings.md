# Findings

Dated measurements from this machine's record, each with what it can and cannot carry. They go stale; a design decision that rests on one links here.

## Where rules reach the work

- **Most edits run under no skill** (2026-09-16). 82% of file edits carry no skill attribution; `build` carries 3.8%. A rule in a skill reaches a sliver of the work; a rule in `AGENTS.md` or `CLAUDE.md` reaches all of it. Unskilled edits also drew a later `fix:` 18.9% of the time, against 7.4% under `build`.
- **A rule can be missing rather than ignored** (2026-09-16). Twelve "hack" corrections in one day all went to Codex, whose `~/.codex/AGENTS.md` held no conventions. Ask where a repeated rule lives before asking why it was broken.
- **The repetition an n-gram counter cannot see** (2026-09-17). "Don't add unnecessary comments" was typed at least six times across 29 sessions, worded differently each time, so `q repeats` finds none of them — and the rule was loaded every time. Instructions did not hold; the gates held every time. This is why the comment rule became a gate.
- **Git is the least-guided tool** (2026-09-17). The `git` skill was loaded in a third of the sessions that committed, and `git -C` ran 1,250 times against a rule forbidding it.
- **Git aimed outside the session's directory fails three times as often** — 10% against 3.2%. Only a `PreToolUse` hook can compare the two.

## What the record can and cannot grade

- **A skill's versions are samples of one.** Most `handoff` versions were loaded in a single session, so version-against-version comparisons are noise.
- **Effort does not grade the work** (2026-09-17). Sessions whose work held took more turns and drew more pushback per file than sessions whose work came back. A grade rewarding fewer turns rewards stopping early.
- **A fix rate grades the month, not the station** (2026-09-17). Every station's rate rose from August to September, unskilled work included; the project mix moved, not the stations.
- **A station's fix rate grades the code it is pointed at** (2026-09-17). Files reach `simplify` already fixed at four times the rate of files reaching `build`, and leave lower. Unexplained: files edited under `agents-md` draw four times more fixes after than before.
- **Delegating has cost nothing measurable**, but the arms compare review-shaped sessions with build-shaped ones, so it settles nothing about delegating builds.
- **The only outcome signal is a later `fix:` commit**, and it misses fixes without the prefix, fixes on code the session never wrote, and wrong work nobody came back to.

## Checks need judgement

- **Review already finds nothing, most of the time** (2026-09-16). 72% of sessions that loaded `review` made no edit under it. That counts only findings fixed during the review, so it is a floor.
- **A word list cannot find a narrating comment** (2026-09-17). All twelve matches for "used to", "no longer", "now" and the like were legitimate comments.
- **A reviewer catches what a word list cannot** (2026-09-17). A planted-defect test: the checking agent found all three planted comments, one unplanted, and a real dead-and-silent trace writer. On the push gate it found a backwards rule 250 green tests missed.

## The manual workflow

- **The workflow the factory copies was never written down** (2026-09-20). `q search` could not answer how work is designed, built and reviewed, because the index holds only distilled text. [`my-workflow.md`](my-workflow.md) now does.
- **What the record showed**: review is the widest fan-out, one agent per dimension; a second model is asked for in prose, never by name, and argued with in rounds; planning as its own step barely exists; the handoff is the most-run step of all.
- **Review finds and fixes** (2026-09-20). Across 47 slices the checking loop raised 231 findings, docs, correctness and tests leading. That shows an active loop, not a defect rate.

## Retrieval

- **Meaning is found where the words match, or not at all** (2026-09-17). `dim bench` over 16 hand-labeled questions: recall@10 0.531, nDCG@10 0.472, bimodal — seven questions perfect, six at zero. Word overlap does not explain the split.
- **An ANDed keyword search grows fourfold per doubling of terms** (2026-09-17): 400 words took 64 seconds, 4,000 took 1 h 43 min. Unioning one match per term (2026-09-20) keeps 16 stopwords under 0.7 s, so the cap stays at 16 terms.
- **Injected text floods the keyword index** (2026-09-17). One harness reminder repeats across 295 sessions; coordinator and peer messages carry the same flag but are real, so `origin_kind` separates them.
- **A passage ref needs the whole timestamp** (2026-09-18). Cut to the minute, one session in 33 collides; `@` already appears in subagent session ids, so a ref is read by the timestamp's shape.
- **`prior-art` matches a path, not a meaning.** `lexer` finds nothing while a `log-parser.ts` sits on disk.

## Harness behavior

- **A tenth of "pushback" was the harness refusing itself** (2026-09-18). `automode-blocked` and `automode-unavailable` are auto mode, not the owner.
- **Codex edits are invisible to edit counts** (2026-09-18). Codex writes `FileChange` where Claude writes `Edit` and `Write`, and records stops on `turn.status`, which the correction queries do not read.
- **Claude Code headless** (2026-09-25, 2.1.282). `acceptEdits` works in `-p`. An empty `ANTHROPIC_API_KEY` in `--settings` overrides a project key. Sandboxed Bash can write the whole session `$TMPDIR`, and a linked worktree's common git dir, so what a builder must not write there has to be denied. `--resume` works from another directory. `--bare` and an empty `CLAUDE_CONFIG_DIR` lose the login.
- **Worker launch settings remove background tools** (2026-09-26, 2.1.282). `ScheduleWakeup`, `CronCreate`, `Monitor` and `RemoteTrigger` leave the tool list; `CronList` and `CronDelete` stay.
- **Bun paints stderr** (2026-09-18, 1.3.14). `console.error` adds color escapes under `FORCE_COLOR` even into a pipe, breaking exact-output tests, so diagnostics go through [`src/cli-warn.ts`](../src/cli-warn.ts) and `noConsole` is on.

## Hazards met in practice

- **A hook that reads a file can be stopped by it** (2026-09-17). A `Makefile` that is a FIFO blocks the read, and a `SessionStart` hook that never returns is a session that never starts. Read only regular files, capped.
- **The push gate is off in a repo created rather than cloned** (2026-09-17). `git init` plus `push -u` never sets `refs/remotes/origin/HEAD`; `git remote set-head origin -a` arms it, and `dim doctor` reports it.
- **A table is new in the diff long after it stopped being new on disk** (2026-09-19). A wall under `bun --hot` created a draft table before it was committed, so changing a column needs a schema bump whatever the table's age.
- **A proof by removal can pass without proving anything** (2026-09-18). A shell edit that silently matched nothing left the invariant in place and the suite green. Read the red, not the exit code, and edit through the file tools.
- **A subagent's explanation needs checking at the code** (2026-09-18). A builder blamed a flaky test on a hook that cannot reach the test's git calls, and adopted a workaround on that basis.
- **The same script, five times, already drifted** (2026-09-17). Five tooling scripts shared between two product lines had all diverged, three of them jobs `dim` does once.

## Dart comments

- **Only `web-tree-sitter` 0.25 reads the prebuilt Dart grammar** (2026-09-26, Bun 1.4.2). 0.26 and 0.27 refuse its WebAssembly format; 0.20 its language version. 0.25.10 reported exactly the sample's four comments and nothing inside strings.

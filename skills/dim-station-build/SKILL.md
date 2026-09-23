---
name: dim-station-build
description: Run the slice loop — the repo's own check, a simplification pass, a checking agent on the diff, an answer to every finding, then the commit, one slice at a time. Invoked by dim-line-feat and dim-line-fix after their own first phase; use directly only for a change that is neither.
argument-hint: "<what to build>"
---

# Build

The shared half of both fronts. `dim-line-feat` arrives here having cut the work into slices; `dim-line-fix` arrives with a failing test and a named cause. What follows is the same either way.

One agent, in one session. The work is edits, and edits need the context that produced them to stay coherent across slices; a subagent returns a conclusion and keeps its evidence. That is a good trade for a review, where findings are the product, and a bad one here.

This is a decision to measure rather than a principle. `build` has handed work to a subagent five times in the whole corpus, so nothing says fan-out is worse here — it says nobody has tried it. The review arm that did fan out is confounded by being review ([`findings.md`](../../docs/findings.md), "Delegating has cost nothing measurable"). Fan-out in a build is a change that earns its way in through a measured arm, not an assumption.

What makes this a station is that the record aims it. This machine knows which files a later `fix:` commit had to come back to, which shipped untouched, and what the owner has had to say more than once.

## Entry contract

1. **Know what checks this.** Read the command the repo declares — a `package.json` script, a `mise` task, a `Makefile` target — and use it. `dim check-command` prints it. Running what the repo declares is what makes a local check the same check CI runs; an equivalent command assembled by hand is not that.
2. **Read the rules actually in force.** The standing corrections live in the guidance files, not in a phrase counter — `dim q repeats` returns conversational filler and the corrections are not in it ([`findings.md`](../../docs/findings.md), "The repetition an n-gram counter cannot see"). Read the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included, and treat a rule a session has already restated as one that is not taking hold rather than one the agent ignored.
3. **Know which ground has broken.** `dim q fixes` gives the share of files edited under each skill that a later fix commit came back to, each row carrying the file count its rate stands on — a skill with one file reads as 0% or 100%, so that count is the column to look at first. It names no path, so it says which kind of work has been coming back rather than which file here did. `dim q exemplars` does name paths — the most-edited code that shipped with no fix returning to it — and those are candidates rather than verdicts, since a file nobody came back to may have been right or may have been abandoned. A front arriving here has already asked this; a change that came in directly asks it now.

## Slices

A slice is a vertical cut: it changes behavior, it is checked on its own, and it is committed on its own. Work through them one at a time, running the repo's task at the end of each, and commit what passes before starting the next. A branch of unverified slices is one slice with a long diff.

A red check is feedback to the builder. Diagnose and fix its cause, rerun the check, and continue until the final commit passes; report a blocker only when the cause cannot be resolved in the current station.

Commit in the same order every time: the task passes, the slice is simplified, the task passes again, the reviewer reads what will land, every finding it raises is answered and the task passes over the answers, then the commit, then the next slice.

Use `dim-git` at the commit boundary. It owns the repository status, worktree ownership, evidence recorded with the commit and the rules for later integration; this station owns the slice loop.

Use `dim-tdd` for behavior-changing slices and `dim-simplify` for the simplification pass. Their methods remain shared; this station supplies the slice boundary, repository evidence and finding loop.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## Produce the Build artifact

Use `dim-artifact` for the shared artifact-writing contract. The Build artifact is the builder's explanation of the completed slice, grounded in the recorded diff and checks:

After the final slice has a passing check, return one Build artifact for the owner. Lead with what became true and why, then name the commits, changed behavior, checks, review-relevant evidence, deviations from the approved plan, and unresolved risks. Keep the detail proportional to the change while retaining the evidence and worker attribution. The Build artifact is provisional until review is accepted; the operator checks it against the recorded evidence before delegating review and the builder updates it when review returns the work.

## Simplify the slice before it is checked

The slice that just went green is the code most recently written and least read, so it needs no aiming. Nothing ever asks for simplification, and a pass that has to be remembered is a pass that does not happen — which is why it runs here rather than waiting to be invoked.

Read the slice's own diff and nothing else. Scope is the cut: a file the slice did not touch is a separate change, and reaching for one is how a slice turns into a branch with a long diff.

What earns an edit is a reader's cost — a name that has to be held in the head, a nesting level that carries no case, a block written twice, an abstraction with one caller. What does not is taste: shorter is not simpler, and a line that reads plainly stays.

**Behavior is preserved exactly, and the test for that is mechanical: the repo's task passes again, and this pass's own diff touches no test file.** A test edited to accommodate a simplification means the behavior moved, which makes it a different change and not this one. The comparison is this pass's diff rather than the slice's, because a `dim-line-fix` slice carries the failing test that proved the defect and that edit is the point of it. Run the task after this pass, before the reviewer, or the reviewer judges code that is about to change.

**An edit lands only by lowering one of the costs named above, and the pass names which.** A pass that can name none is the fixpoint, and that is the expected result on a slice that was already plain. This is what makes the loop finite: the costs are a list, each edit spends one off it, and a rename that trades one name for another lowers nothing and so is not an edit this pass may make. Judging instead whether anything *could* still be improved is not the test; asked that, there is always something.

**Run the pass again only if the last one changed something**, since one simplification exposes another — a wrapper inlined reveals the two blocks it was hiding. There is no round limit, because a number picked here is a constant no test can prove.

## Check the slice before the next one

Between the simplification pass and the commit, hand the slice's diff to one agent working from a fixed brief, at the tier `dim route codex reviewer` gives you. This is not the fan-out the top of this file argues against: that objection is about delegating the edits, which need the context that produced them. A reviewer returns findings and keeps nothing, which is the trade `dim-station-review` makes and the one the corpus measured as costing nothing.

**Give the reviewer read-only tools.** An agent that can edit answers a finding by editing, and what it overwrites is the fix the builder already made — one was reverted that way on 2026-09-18, caught only because the file tools report an on-disk change ([`build-order.md`](../../docs/build-order.md)).

Bounded means a fixed brief, not "review this". It also means the reviewer is told what to look for: hand it the conventions actually in force — the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included — because the rules it is checking against are written down and a reviewer left to invent them checks its own taste. Give it the diff of this slice alone, what the slice claims to do, and these four questions:

- does every invariant the diff claims have a test that fails without it
- does any comment narrate the change — what the code used to do, what was renamed, what is now different — rather than state the constraint that forced this approach
- did a doc describing this behavior change in the same diff
- is there a fallback, default or catch-and-continue standing in for a decision that was never made

Withhold your own reading. Hand over the diff and the claim, not the conclusion, or what comes back is agreement.

Returning nothing is the expected result and not a sign the check was wasted: of the sessions that loaded `review` in this corpus, 72% made no edit under it ([`findings.md`](../../docs/findings.md), "Review already finds nothing, most of the time"). A reviewer earns trust the way a test does — plant a defect once, watch it be caught, take it out — and after that an empty result is the good news it reads as.

### Every finding gets an answer

**Answer each finding before the commit: fix it, or refuse it and write down why**, so the diff goes out with nothing in it that was merely not mentioned. Check the claim at its source before either answer — a reviewer's reading is a claim like any other, and one taken on trust is how a wrong finding becomes the standard. Where a refusal turns on whether a finding is true rather than on whether it matters, the operator settles it: a refused finding holds the ship until it is acknowledged, which puts a hand that neither wrote the code nor raised the finding on the disagreement, and costs no model call.

**Run the repo's task over the answers, then hand the reviewer what it had the first time plus the diff that answers.** The same brief, the same conventions, the same four questions — a reviewer given only a patch has nothing to judge it against but its own taste. The answering diff is the one part of the slice nothing has read: it was written after the reviewer's pass, which is what the round is for.

**The loop ends when no finding is unanswered — never when no findings exist.** Asked whether anything could still be improved, a reviewer always says yes, so that test does not terminate. A refusal with a reason ends a finding as completely as a fix does; if refusing cost anything, the cheap way out would be to fix whatever was raised, which is the same loop with the answer decided in advance. A round where every finding was refused changes no code, so there is nothing to re-read and the slice commits. What makes this finite is the same thing that bounds the first pass: the reviewer answers four closed questions about one diff, not whether the diff could be better, and each round hands it a smaller diff than the last was written against. There is no round limit, for the reason the simplification pass has none.

Two answers that read as evasions and are not: a finding that is true and does not matter here, refused and said so; and a finding that is true and belongs to a different slice, written into [`build-order.md`](../../docs/build-order.md) rather than folded in, which is what keeps the diff one thing.

**Record each answer as you make it**, with `dim finding --slice <name> --dimension <name> --answer fixed|refused --summary "..."`, plus `--file` where the finding names one and `--why` on a refusal. Write it when the finding is answered rather than at the end: the judgement exists only in this session, nothing re-reads it into the database afterward, and a round recalled later is a round summarized. `dim q findings` reads them back by dimension, which is what can eventually say whether checking pays — it grades the reviewer and never the builder, so a slice that drew several findings is not a worse slice.

## Exit check

The change is done when:

- the repo's own task passes, and its output was read rather than assumed
- every finding on every slice was answered, by a fix or by a stated refusal, and the diff that answered was itself read
- the last simplification pass on each slice changed nothing, and no test file was touched to let one through
- every invariant claimed has a test that fails when the invariant is removed — delete the check, watch it go red, put it back
- the docs that describe the changed behavior changed in the same commit
- anything left out is named, with the reason

## When to stop and ask

Unattended, stop only where the choice is genuinely the owner's: work that is hard to reverse, work that is outward-facing, or a change that spends something on every session rather than this one. Everything else is settled here and stated. A question a query could have answered should have been a query.

## See also

- `dim-artifact`

## What the record cannot tell you

`dim q fixes` says work done under a skill drew later fix commits at some rate. That is the repo's verdict on earlier changes, never on yours, and code nobody came back to may have been right or may have been abandoned.

And effort is not a grade. Work that held took more turns per file than work that came back, more pushback, and more commands ([`findings.md`](../../docs/findings.md), "Effort does not grade the work"). A slice finished quickly is not a slice done well, and the check that was skipped is the usual reason it was quick.

## Red flags

- starting the next slice before the current one is checked and committed
- changing a test to make simplification pass
- giving the reviewer edit access
- treating a passing process exit as a verified build

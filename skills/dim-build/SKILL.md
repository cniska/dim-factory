---
name: dim-build
description: Build an approved plan slice by slice — the repo's own check, a simplification pass, a checking agent on the diff, an answer to every finding, then the commit handed to the slice gates. Use as the builder, when a brief names dim-build.
argument-hint: "<what to build>"
---

# Build

One agent, in one session. The work is edits, and edits need the context that produced them to stay coherent across slices; a subagent returns a conclusion and keeps its evidence. That is a good trade for a review, where findings are the product, and a bad one here.

What makes this a station is that the record aims it. This machine knows which files a later `fix:` commit had to come back to, which shipped untouched, and what the owner has had to say more than once.

## A factory turn

The brief carries only what this skill cannot know: the `order`, the `workspace`, the approved `plan` with each slice's `commit` once it has one, `returned` (why the order came back), the open review `findings` by id, and a `conflict` from a rebase. Build every slice without a commit, in order, in this one turn.

- **Scope.** Build the approved plan. Do not edit or test a surface the order or the plan excludes. When a slice fixes a defect, write the test that fails on it before the fix.
- **A slice's commit.** When a slice passes the loop below, commit it with `git add -A && git commit -m "<subject>"` and hand it in with `dim slice submit`. Your nth commit is the plan's nth slice; a commit after the last slice is a fix. The subject follows `dim-git`.
- **A refused slice.** The reply names what the gate saw — the check's failure, a moved head, uncommitted changes, a changed check. The branch is back where it was and your changes are still in the workspace: fix the cause, commit again and submit again.
- **Review findings.** Answer each one once, by its id, after its fix is submitted: `dim finding answer <id> fixed --reason "<what changed>"`, or `refused --reason "<why not>"`.
- **A returned Build artifact.** Change the code where the reason asks for a change; the revision itself follows `dim-artifact`.
- **A problem in the plan.** When the plan cannot be built as approved, run `dim order return --reason "<the problem>"`; slices already committed stay on the branch.
- **The return.** When every slice is committed, every finding answered and the workspace clean, write the Build artifact to a file under `$TMPDIR` and run `dim build return <file>`. A reply naming what is missing records nothing: finish it and return again.
- **Reading the order.** `dim order show` prints it, and `dim query` reads the record.

## Entry contract

1. **Know what checks this.** Read the command the repo declares — a `package.json` script, a `mise` task, a `Makefile` target — and use it; `verify` comes first, then `check`, `ci`, `validate` and `test`. It is what `dim slice submit` runs on your commit. Running what the repo declares is what makes a local check the same check the gate runs; an equivalent command assembled by hand is not that.
2. **Read the rules actually in force.** The standing corrections live in the guidance files. Read the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included, and treat a rule a session has already restated as one that is not taking hold rather than one the agent ignored.

## Slices

A slice is a vertical cut: it changes behavior and is checked on its own. Work through them one at a time, running the repo's task at the end of each. Outside a factory order, commit what passes before starting the next. A branch of unverified slices is one slice with a long diff.

A red check is feedback to the builder. Diagnose and fix its cause, rerun the check, and continue until the final commit passes; report a blocker only when the cause cannot be resolved in the current station.

Finish a slice in the same order every time: the task passes, the slice is simplified, the task passes again, the reviewer reads what will land, every finding it raises is answered and the task passes over the answers, then the commit boundary, then the next slice.

Use `dim-git` at the commit boundary. The factory records the check and the commit when `dim slice submit` accepts them. This station owns the slice loop.

Use `dim-tdd` for behavior-changing slices and `dim-simplify` for the simplification pass. Their methods remain shared; this station supplies the slice boundary, repository evidence and finding loop.

An edit repeated across many sites — a rename, a changed signature, one pattern removed everywhere — is a codemod over the parsed code rather than a sweep by hand, the way `dim comments purge` rewrites through `@babel/parser`: a transform that refuses what it cannot parse reaches every site or says which it could not, while a hand sweep misses a site silently. Run it, read its diff, then edit by hand only the sites that need judgement.

Where the comment gate is on — `dim doctor` says so for the repo it runs in — write no comments at all. A why goes into a name, a test that holds the invariant, or the doc that owns the subject; those are the places the gate leaves for it.

Where a slice turns out to be blocked, finish every other slice in full and say plainly what was left and why. Scaling the work down is the owner's call.

## Produce the Build artifact

For a factory order, use `dim-artifact` for the shared artifact-writing contract. The Build artifact is the builder's explanation of the completed order, grounded in the recorded diff and checks. Outside an order, report the verified change directly to the requester.

After the final order slice passes the check you ran, return one Build artifact for the owner. Structure it around the questions that are not answered by the diff alone:

- **Outcome.** What is true for the owner now and why it satisfies the requested result.
- **Implementation.** The meaningful behavior and boundaries that changed, grouped by logical change rather than by file or slice.
- **Why this shape.** The load-bearing choices, alternatives not taken, and non-obvious contracts or trust dependencies.
- **Verification.** What the recorded checks and review evidence establish, stated as conclusions rather than a command transcript.
- **Owner attention.** Deviations from the approved plan, unresolved risks, and what a careful reader should scrutinize.

Use only the sections the change earns. Do not repeat the audit log's command output, exhaustive file list, slice history, or unrelated failures. The Build artifact explains the result; it does not replace the record, review, or approval. The builder also updates it when review returns the work.

## Simplify the slice before it is checked

The slice that just went green is the code most recently written and least read, so it needs no aiming. Nothing ever asks for simplification, and a pass that has to be remembered is a pass that does not happen — which is why it runs here rather than waiting to be invoked.

Read the slice's own diff and nothing else. Scope is the cut: a file the slice did not touch is a separate change, and reaching for one is how a slice turns into a branch with a long diff.

What earns an edit is a reader's cost — a name that has to be held in the head, a nesting level that carries no case, a block written twice, an abstraction with one caller. What does not is taste: shorter is not simpler, and a line that reads plainly stays.

**Behavior is preserved exactly, and the test for that is mechanical: the repo's task passes again, and this pass's own diff touches no test file.** A test edited to accommodate a simplification means the behavior moved, which makes it a different change and not this one. The comparison is this pass's diff rather than the slice's, because a defect's slice carries the failing test that proved it and that edit is the point of it. Run the task after this pass, before the reviewer, or the reviewer judges code that is about to change.

**An edit lands only by lowering one of the costs named above, and the pass names which.** A pass that can name none is the fixpoint, and that is the expected result on a slice that was already plain. This is what makes the loop finite: the costs are a list, each edit spends one off it, and a rename that trades one name for another lowers nothing and so is not an edit this pass may make. Judging instead whether anything *could* still be improved is not the test; asked that, there is always something.

**Run the pass again only if the last one changed something**, since one simplification exposes another — a wrapper inlined reveals the two blocks it was hiding. There is no round limit, because a number picked here is a constant no test can prove.

## Check the slice before the next one

Between the simplification pass and the commit, hand the slice's diff to one agent working from a fixed brief. This is not the fan-out the top of this file argues against: that objection is about delegating the edits, which need the context that produced them. A reviewer returns findings and keeps nothing, which is the trade `dim-review` makes.

**Give the reviewer read-only tools.** An agent that can edit answers a finding by editing, and what it overwrites is the fix the builder already made — one was reverted that way on 2026-09-18, caught only because the file tools report an on-disk change.

Bounded means a fixed brief, not "review this". It also means the reviewer is told what to look for: hand it the conventions actually in force — the `CLAUDE.md` and `AGENTS.md` on the walk into this session, imports included — because the rules it is checking against are written down and a reviewer left to invent them checks its own taste. Give it the diff of this slice alone, what the slice claims to do, and these four questions:

- does every invariant the diff claims have a test that fails without it
- in anything the comment gate does not judge — every file where it is off, and where it is on, files other than JS and TS and the prose after a tool directive — does any comment narrate the change — what the code used to do, what was renamed, what is now different — rather than state the constraint that forced this approach
- did a doc describing this behavior change in the same diff
- is there a fallback, default or catch-and-continue standing in for a decision that was never made

Withhold your own reading. Hand over the diff and the claim, not the conclusion, or what comes back is agreement.

Returning nothing is the expected result and not a sign the check was wasted. A reviewer earns trust the way a test does — plant a defect once, watch it be caught, take it out — and after that an empty result is the good news it reads as.

### Every finding gets an answer

**Answer each finding before the commit: fix it, or refuse it and write down why**, so the diff goes out with nothing in it that was merely not mentioned. Check the claim at its source before either answer — a reviewer's reading is a claim like any other, and one taken on trust is how a wrong finding becomes the standard.

**Run the repo's task over the answers, then hand the reviewer what it had the first time plus the diff that answers.** The same brief, the same conventions, the same four questions — a reviewer given only a patch has nothing to judge it against but its own taste. The answering diff is the one part of the slice nothing has read: it was written after the reviewer's pass, which is what the round is for.

**The loop ends when no finding is unanswered — never when no findings exist.** Asked whether anything could still be improved, a reviewer always says yes, so that test does not terminate. A refusal with a reason ends a finding as completely as a fix does; if refusing cost anything, the cheap way out would be to fix whatever was raised, which is the same loop with the answer decided in advance. A round where every finding was refused changes no code, so there is nothing to re-read and the slice commits. What makes this finite is the same thing that bounds the first pass: the reviewer answers four closed questions about one diff, not whether the diff could be better, and each round hands it a smaller diff than the last was written against. There is no round limit, for the reason the simplification pass has none.

Two answers that read as evasions and are not: a finding that is true and does not matter here, refused and said so; and a finding that is true and belongs to a different slice, written into [`todo.md`](../../docs/todo.md) rather than folded in, which is what keeps the diff one thing.

**Where answers go.** A slice checking agent's findings are answered in the builder's pass and explained in the Build artifact. Only the review findings the brief lists are answered through `dim finding answer`.

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

Effort is not a grade. A slice finished quickly is not a slice done well, and the check that was skipped is the usual reason it was quick.

## Red flags

- starting the next slice before the current one is checked and committed
- changing a test to make simplification pass
- giving the reviewer edit access
- treating a passing process exit as a verified build

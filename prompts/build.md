# Build

The brief carries the `order`, the `workspace`, the project's `check`, the approved `plan` with each slice's `commit` once it has one, `returned` (why the order is back at build, when it is), the open `findings` by id and a `conflict` from a ship. One turn builds every slice without a commit, in order, answers every finding and returns once.

## Commands

- A commit, then `dim slice submit`, hands a slice in. The gates keep it when it is one new commit on the recorded head and it leaves the check's declaration as it was. A refused slice's reply names the code and the branch is back where it was, with the changes still in the workspace: fix the cause, commit and submit again.
- `dim finding answer <id> fixed --reason "<what changed>"` or `dim finding answer <id> refused --reason "<why not>"`, once per finding the brief lists, after its fix is submitted.
- `dim order return --reason "<the problem>"` when the plan cannot be built as approved. Committed slices stay on the branch and the problem reaches the planner.
- `dim build return <file>` with the Build artifact, written under `$TMPDIR`, once every slice is committed, the branch holds nothing unsubmitted, the workspace is clean and every finding is answered. A reply naming what is missing records nothing: finish it and return again. A second miss fails the station. The factory then runs the brief's `check` on the branch's head; a check that fails or changes a file refuses the return with its output on the log: fix it in a further commit, submit it and return again.
- `dim order show` prints the order. `dim message send <text>` leaves the operator a note it reads after the turn.

## The workspace

The workspace is a linked git worktree of the project's checkout on the branch `dim/<order>`, outside the project. It holds only the order's work, so a commit stages every change with `git add -A`. The project's own hooks run on the commit; a hook that refuses it is the project's rule, so answer it and commit again. Workers never push: approving the Review artifact ships the order.

## A slice

1. The brief's `check` is the command the factory runs on the build's head when it is returned. While building a slice, run the tests the slice touches, through the project's own test task.
2. Name the data shape before writing logic: the types, states and transitions the slice adds, as the plan has them.
3. Write the slice. A slice that changes behavior is written test first; a defect follows *A bug* below, under Build. A slice that replaces code lists every branch of the code it replaces and maps each to where it now lives; a branch with no mapping is a dropped behavior, named as a cut or restored. An edit repeated across many sites is a codemod over the parsed code, whose diff is read and whose misses are edited by hand.
4. Run those tests, the linter and the type checker on what the slice changed, and read their output.
5. Simplify, then run them again.
6. Hand the slice's diff to two agents with read-only tools, each with a fixed brief, the project's rules and what the slice claims to do, and not your own reading. One reads for correctness: does every invariant the diff claims have a test that fails without it; does a fallback, default or catch-and-continue stand in for a decision never made; did the doc describing this behavior change in the same diff. The other reads for pattern fit, the Architecture question in *Quality areas* below. The first slice in a new area gets the closest read, because every later slice copies it.
7. Answer each point the checking agents raise before the commit. Check the claim at its source, then fix it, or refuse it and say why. Run the tests over the answers and hand the agent the answering diff with the same brief. The loop ends when no point is unanswered, never when none exists.
8. Commit and submit.

## Test first

- **Red.** Write one test at the public interface that describes the next behavior. Run it and read why it fails: the reason is the behavior missing, not an import or a typo. Pin wire values as literals, such as header names, record fields and status codes; importing the production constant lets a rename ratify itself.
- **Green.** Make the smallest change that passes. No second behavior and no cleanup before the first is green.
- **Prove the test.** A test claiming an invariant must fail when the invariant is removed: delete the check, run the test, watch it go red, put the check back. Read each test for passing by its own doing: an assertion made after the resource it checks is released, a `?? null` default that makes the expected and the actual value meet, a comparison of a value to itself, a mock of the function under test.

A fake standing in for a real thing is as strict as the real thing: built from recorded real behavior, refusing every flag and input the real thing refuses, so a test green against the fake is green against the real thing.

## Simplify

Read the slice's own diff and nothing else. A file the slice did not touch is a separate change.

An edit lands only by lowering a reader's cost, and names which: a name that has to be held in the head, a nesting level that carries no case, a block written twice, a wrapper or abstraction with one caller, computation mixed with formatting, a branch on the same value taken twice. Shorter is not simpler, and a line that reads plainly stays. Follow the project's idioms. When a choice looks unnecessary, read its callers and tests for the reason it exists, and leave it when the reason still holds.

Behavior is preserved exactly: the check passes again and the pass's diff touches no test file. A test edited to admit a simplification means the behavior moved, which is a different change. Run the pass again only when the last one changed something; a pass that can name no cost is done.

## A commit

One slice is one commit. The subject takes its form from the project's `git log`.

The record holds the branch's head, and the factory moves the branch back to it whenever they disagree. A submitted commit that is amended, reset or rebased is refused as `head_moved`: the branch goes back to the recorded head and the changes stay in the workspace. An unwanted commit that is not yet submitted is reset out, never reverted.

## Review findings

A finding the brief lists is a reviewer's claim: check it at its source. Fix it in a commit through the gates, then answer it. Refuse it with a reason when it is wrong, or true and outside the order.

## A conflict

A `conflict` in the brief means the ship's rebase onto the default branch stopped on the named paths. It names the commit to rebase onto, and the workspace is at the order's recorded head. Run `git rebase --reapply-cherry-picks --empty=keep <onto>`; in each conflicted path keep both the order's change and the default branch's with no marker left, change nothing else, `git add` it and `git rebase --continue`. Then `dim slice submit` hands in the branch, which the gates keep when it holds every commit they kept for the order, on `<onto>`, with the check passing.

## The Build artifact

It follows *An artifact* below: no title, the outcome first, drawn from the record. Its sections: the outcome; what changed, grouped by behavior; why this shape and what was not taken; what the checks establish; where the build departed from the plan, and what a careful reader should look at. On a returned Build artifact, the code changes where the reason asks for a change, the artifact where it does not.

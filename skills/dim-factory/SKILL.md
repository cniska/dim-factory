---
name: dim-factory
description: Run a repo's queue — read what that repo has waiting, take the next unblocked item, route it to the station that fits, and stop at the fence. Use to work a backlog without being handed a subject.
argument-hint: "[the queue: a file, a tracker query, or nothing to find it] [how many items, default 1]"
---

# Factory

What starts the work. Every station is handed a subject; this reads the repo's queue and picks one, then invokes the station that fits.

It is not a station. The stations are operations on a subject — scope, build, check — and this runs the line above them, which is why it decides nothing about how work is done and everything about which work is started and when to stop.

That stopping rule is the substance of this file. The argument it serves is dim rather than dark: autonomous between the gates, a person at the gates that matter, each gate earning its automation separately rather than by fiat. A driver that decided that for itself would be answering the question the factory exists to ask.

## 1. Check the floor

- `dim q running` — another session live in this project is editing the same tree, and two builders on one working tree is the collision nothing recovers from. Name the session and stop.
- `dim check-task` — what this repo declares as its check. **A repo declaring none cannot be worked here**, because the slice loop has nothing to run and a slice that cannot be checked cannot be committed. Say so and stop.
- `dim doctor` — a warn on the commit gate means nothing refuses an unchecked commit in a run nobody is watching.
- Working tree clean, or there is uncommitted work that is not yours to land.

## 2. Find the queue

A repo's queue is **read, never inferred** — the rule `dim check-task` already follows for the check command, and it binds harder here, because working the wrong queue is the confident-and-wrong failure a person is at the gate for.

1. **The argument is the queue**, when one is given. `/dim-factory docs/build-order.md` works that file; a tracker query works those issues. Nothing is discovered and nothing else is read as a queue.
2. **Otherwise the repo declares it**, in its `AGENTS.md` or `CLAUDE.md`: a Linear team or project, an issue label, a path.
3. **Otherwise look**, in this order, and say which was found: a queue doc the repo's rules file links; `TODO.md`; open issues in the repo's tracker.
4. **Two plausible queues is a question, not a coin flip.** Name both and stop.

Reading a tracker is your own tools' business — `dim` holds no credential and reaches no network, and nothing here changes that.

## 3. Take an item

Take the first item that is **unblocked and statable in one sentence**. A queue that marks its own blockers is telling you where to start; one that does not means reading enough of each item to know.

An item you cannot state needs scoping, which is `dim-plan` — run it, leave the sharpened item in the queue, and stop there.

| the item | the entry point |
|---|---|
| adds functionality | `dim-feat` |
| repairs something wrong | `dim-fix` |
| neither — a refactor, a doc, a rule | `dim-build` |

**Hand the item to a builder.** Pass the item, base revision and repo check; the builder creates its isolated worktree with `dim wt`, then invokes the station itself and takes the item end to end. Running the station in this session makes the line one worker long, and then the queue is worked one item per invocation whatever this file says about emptying it.

This is not the fan-out `dim-build` argues against. That rule keeps a single slice from being split across agents, because edits need the context that produced them — a builder holding one whole item has exactly that context. What it forbids is two agents editing one slice.

Give the builder the item as the queue states it, the repo's check, and the standing instruction to run its station's loop including the checking agent. Take back what it reports: the commits, the findings, what it left. A builder that returns without a commit and without saying why is a failed attempt, and the bound below counts it.

## 4. The fence

Three shapes stop a run wherever they are met, including partway into an item that read as ready:

- work that is hard to reverse
- work that is outward-facing — a push to a shared branch, a comment on someone's issue, anything leaving this machine
- a change that spends something on every session rather than this one

A queue may draw its own fence on top of these — a section its rules file marks as the owner's call, a label, a state. Read it as binding and never move it: the owner moves a fence by editing the queue, not by an agent deciding an item looked fine.

Stopping means writing down what was found, leaving the item where it was, and naming which shape stopped it. Waiting for permission mid-run is not running unattended; deciding one of these alone is what the fence exists to prevent.

## 5. Keep the line moving

**Work the queue until it is empty.** Take the next item the moment one lands, and do not come back between items to say a thing went well — a line that halts after every job is not running, and a report per item is the report at the end read one piece at a time.

Four things stop it, and nothing else does:

- a fence, per above
- the item count, when one was given as an argument
- **the same item failing twice** — a second failure says the item is wrong, not the attempt, so leave it and take the next one
- **two items failing in a row** — that is the floor moving rather than the items, and the next thing to do is read why rather than start a third

A failed attempt usually leaves the queue exactly as it was, so nothing but these keeps a run from taking the same item forever.

## 6. Report

Per item, landed or not:

- the item taken, quoted, and the queue it came from
- where it went, and the commits
- what `dim q findings` recorded for the slice
- what stopped the run, and which shape it was

A run that took nothing and says why is a complete run. A queue with no startable item is a finding about the queue.

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

1. **The argument is the queue**, when one is given. `/dim-factory queue.json` works that planner file, `/dim-factory docs/backlog.md` works that document, and a tracker query works those issues. Nothing is discovered and nothing else is read as a queue.
2. **Otherwise the repo declares it**, in its `AGENTS.md` or `CLAUDE.md`: a Linear team or project, an issue label, a path.
3. **Otherwise look**, in this order, and say which was found: a planner file the repo tracks — `queue.json` at its root, or the path its rules file names, and only where `dim queue ready` parses it, since another file of that name is another format; a queue doc the repo's rules file links; `TODO.md`; open issues in the repo's tracker.
4. **Two plausible queues is a question, not a coin flip.** Name both and stop.

**A planner file states its own items, so nothing about one is retyped.** `dim queue ready <file> [--limit <n>]` prints every unblocked item as JSON — its `id`, `title`, one-sentence `description` and `status` — and `dim queue transition <file> <item> <status> [--reason <text>]` records it moving. The id, title and description are what the claim below carries; the status is the item's own, and the job's is separate. A repo may keep a document beside the file carrying the same ids: the file owns each item's state, and the document owns the order and any fence the file cannot express.

Reading a tracker is your own tools' business — `dim` holds no credential and reaches no network, and nothing here changes that.

## 3. Take an item

Take the first item that is **unblocked and statable in one sentence**. A queue that marks its own blockers is telling you where to start; one that does not means reading enough of each item to know.

From a planner file, `dim queue ready <file>` is that list: an item it does not print is either waiting on a dependency or already past `planned`, and either way is not yours to take. It sorts by id, which is not priority, so where a document beside the file carries the order, take the item that document ranks highest among the ones `ready` printed, and read that item's section for a fence before taking it.

An item you cannot state needs scoping, which is `dim-station-plan` — run it, leave the sharpened item in the queue, and stop there.

| the item | the entry point |
|---|---|
| adds functionality | `dim-line-feat` |
| repairs something wrong | `dim-line-fix` |
| neither — a refactor, a doc, a rule | `dim-station-build` |

**Hand the item to a builder**, at the tier `dim route builder` gives you. Pass the item, base revision, repo check and the branch the claim below recorded; the builder creates its isolated worktree with `dim wt <branch>`, then invokes the station itself and takes the item end to end. Running the station in this session makes the line one worker long, and then the queue is worked one item per invocation whatever this file says about emptying it.

This is not the fan-out `dim-station-build` argues against. That rule keeps a single slice from being split across agents, because edits need the context that produced them — a builder holding one whole item has exactly that context. What it forbids is two agents editing one slice.

Give the builder the item as the queue states it, the repo's check, and the standing instruction to run its station's loop including the checking agent. Take back what it reports: the commits, the findings, what it left. A builder that returns without a commit and without saying why is a failed attempt, and the bound below counts it.

## 4. Record the job

Every item taken is claimed before a builder sees it, started when the builder starts, and stopped once whatever happened. An item worked without a claim is work nobody watching can see, and a claim that never stops is a card left on the floor.

Mint one run id per invocation — `run-$(date -u +%Y%m%dT%H%M%SZ)` — and one job id per item, `<run-id>-<item-id>`, with a suffix on a retry so a second attempt is its own card rather than a name the record already holds and refuses.

```
dim job claim <job-id> --run <run-id> --queue <queue-id> --item <item-id> \
  --title "<the item's title>" --description "<the item's statement>" \
  --station <the station it routed to> \
  --branch <branch> --worktree "$(dim wt path <branch>)"
dim job start <job-id>
dim job stop <job-id> <completed|blocked|fenced|failed|abandoned> [--reason "..."]
```

- The queue id and item id are what step 2 identified: a planner file's own `id` and the item's `id` in it, or the path or tracker query that named the queue and the item's identity there.
- **The title, the statement and the ids come from the queue, not from you.** Against a planner file they are the `id`, `title` and `description` `dim queue ready` printed, passed through unedited; a claim that paraphrases an item records a second version of it.
- **The title is the item's name, never its id.** It is what every card is read by; the ids are there for an agent to join on.
- A planner file also holds the item's own state, so the item moves as the job does: `dim queue transition <file> <item> claimed` before the builder, `running` when it starts, and `completed`, `blocked`, `fenced` or `failed` at the end, with `--reason` wherever the job stopped for one. An item dropped before a builder started it is `cancelled`. Every one of those five is terminal and refused a further transition, the way a stopped job is, so an item recorded `blocked` leaves `ready` until someone edits the file — record it only where that is what you mean.
- Naming the branch is yours, because the claim records it before the builder exists. `dim wt path <branch>` prints where that worktree will be without creating it, so the claim carries the location the builder then makes.
- `--agent <id>` when the harness gives the builder a stable identity; without it the card names no worker.
- **Stop exactly once, whatever happened**: the item landed (`completed`), it waits on something else (`blocked`), a fence stopped it (`fenced`, with the shape as the reason), the builder failed or returned nothing it could explain (`failed`), or it was dropped (`abandoned`). A stopped job is refused a second lifecycle event, so a retry is a new job id.

Evidence past the lifecycle — commits, checks, findings, changed files, documents — has no command yet. It travels in the report, and `dim q factory <job-id-prefix>` reads back what was recorded.

## 5. The fence

Three shapes stop a run wherever they are met, including partway into an item that read as ready:

- work that is hard to reverse
- work that is outward-facing — a push to a shared branch, a comment on someone's issue, anything leaving this machine
- a change that spends something on every session rather than this one

A queue may draw its own fence on top of these — a section its rules file marks as the owner's call, a label, a state. Read it as binding and never move it: the owner moves a fence by editing the queue, not by an agent deciding an item looked fine.

Stopping means writing down what was found, leaving the item where it was, naming which shape stopped it, and stopping the job as `fenced` with that shape as the reason. Waiting for permission mid-run is not running unattended; deciding one of these alone is what the fence exists to prevent.

## 6. Keep the line moving

**Work the queue until it is empty.** Take the next item the moment one lands, and do not come back between items to say a thing went well — a line that halts after every job is not running, and a report per item is the report at the end read one piece at a time.

The skill may be invoked repeatedly by whatever is driving it. Each invocation starts by reading the current floor and queue state; it never assumes that an earlier invocation finished, failed, or released an item. An active job is observed rather than claimed again. Independent items may run in parallel only when their claims are isolated; claiming, integration and queue-state transitions remain serialized. Repetition never crosses a fence or turns an unrecorded outcome into success.

Four things stop it, and nothing else does:

- a fence, per above
- the item count, when one was given as an argument
- **the same item failing twice** — a second failure says the item is wrong, not the attempt, so leave it and take the next one
- **two items failing in a row** — that is the floor moving rather than the items, and the next thing to do is read why rather than start a third

A failed attempt usually leaves the queue exactly as it was, so nothing but these keeps a run from taking the same item forever.

## 7. Report

Per item, landed or not:

- the item taken, quoted, and the queue it came from
- the job id and the status it stopped at
- where it went, and the commits
- what `dim q findings` recorded for the slice
- what stopped the run, and which shape it was

A run that took nothing and says why is a complete run. A queue with no startable item is a finding about the queue.

---
name: dim-factory
description: Run a repo's queue — read what that repo has waiting, take the next unblocked item, route it to the station that fits, and stop at the fence. Use to work a backlog without being handed a subject.
argument-hint: "[the queue: a file, a tracker query, or nothing to find it] [how many items, default 1]"
---

# Factory

What starts the work. Every station is handed a subject; this reads the repo's queue and picks one, then invokes the station that fits.

It is not a station. The stations are operations on a subject — scope, build, check — and this runs the line above them, which is why it decides nothing about how work is done and everything about which work is started and when to stop.

That stopping rule is the substance of this file. The argument it serves is dim rather than dark: autonomous between the gates, a person at the gates that matter, each gate earning its automation separately rather than by fiat. An operator that decided that for itself would be answering the question the factory exists to ask.

## Check the floor

- `dim q running` — another session live in this project is editing the same tree, and two builders on one working tree is the collision nothing recovers from. Name the session and stop.
- `dim check-command` — what this repo declares as its check. **A repo declaring none cannot be worked here**, because the slice loop has nothing to run and a slice that cannot be checked cannot be committed. Say so and stop.
- `dim doctor` — a warn on the commit gate means nothing refuses an unchecked commit in a run nobody is watching.
- Working tree clean, or there is uncommitted work that is not yours to land.
- `dim wall` — the board is what the owner watches the run on, so it goes up before the first item is taken rather than after the fact. Print the address it names back to them and leave opening it to them; a wall already listening there is the one they have open, and the refusal saying so is the answer, not a reason to start a second. Working `dim-factory` itself, run `dim wall --dev`, which adds hot reload to the page the run may be editing.

## Find the queue

A repo's queue is **read, never inferred** — the rule `dim check-command` already follows for the check, and it binds harder here, because working the wrong queue is the confident-and-wrong failure a person is at the gate for.

1. **The argument is the queue**, when one is given. `/dim-factory queue.json` works that planner file, `/dim-factory docs/backlog.md` works that document, and a tracker query works those issues. Nothing is discovered and nothing else is read as a queue.
2. **Otherwise the repo declares it**, in its `AGENTS.md` or `CLAUDE.md`: a tracker's team or project, an issue label, a path.
3. **Otherwise look**, in this order, and say which was found: a planner file the repo tracks — `queue.json` at its root, or the path its rules file names, and only where `dim queue ready` parses it, since another file of that name is another format; a queue doc the repo's rules file links; `TODO.md`; open issues in the repo's tracker.
4. **Two plausible queues is a question, not a coin flip.** Name both and stop.

**A planner file states its own items, so nothing about one is retyped.** `dim queue ready <file> [--limit <n>]` prints every unblocked item as JSON — its `id`, `title`, one-sentence `description` and `status` — and `dim queue transition <file> <item> <status> [--reason <text>]` records it moving. A repo may keep a document beside the file carrying the same ids: the file owns each item's state, and the document owns the order and any fence the file cannot express.

Reading a tracker is your own tools' business — `dim` holds no credential and reaches no network, and nothing here changes that.

## Take an item

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

## Record the order

Every item taken is claimed before a builder sees it, started when the builder starts, and stopped once whatever happened. An item worked without a claim is work nobody watching can see, and a claim that never stops is a card left on the floor.

Mint one run id per invocation — `run-$(date -u +%Y%m%dT%H%M%SZ)` — and one order id per item, `<run-id>-<item-id>`, with a suffix on a retry so a second attempt is its own card rather than a name the record already holds and refuses.

```
dim order claim <order-id> --run <run-id> --queue <queue-id> --item <item-id> \
  --title "<the item's title>" --description "<the item's statement>" \
  --agent <builder-id> --station <plan|build|review|ship> \
  --branch <branch> --worktree "$(dim wt path <branch>)"
dim order start <order-id>
dim order move <order-id> --station <plan|build|review|ship>
dim order stop <order-id> <completed|blocked|fenced|failed> [--reason "..."]
```

- The queue id and item id are what finding the queue identified: a planner file's own `id` and the item's `id` in it, or the path or tracker query that named the queue and the item's identity there.
- **The title, the statement and the ids come from the queue, not from you.** Against a planner file they are the `id`, `title` and `description` `dim queue ready` printed, passed through unedited; against a document or a tracker the statement is the one sentence taking an item required before it could be taken. A claim that paraphrases an item records a second version of it.
- **The title is the item's name, never its id.** It is what every card is read by; the ids are there for an agent to join on.
- A planner file also holds the item's own state, so the item moves as the order does: `dim queue transition <file> <item> claimed` before the builder, `running` when it starts, and `completed`, `blocked`, `fenced` or `failed` at the end, with `--reason` wherever the order stopped for one. An item dropped before a builder started it is `cancelled`. Every one of those five is terminal and refused a further transition, the way a stopped order is, so an item recorded `blocked` leaves `ready` until someone edits the file — record it only where that is what you mean.
- Naming the branch is yours, because the claim records it before the builder exists. `dim wt path <branch>` prints where that worktree will be without creating it, so the claim carries the location the builder then makes.
- **`--agent <id>` names the builder, and is not optional in practice.** Without it the card names no worker, and several orders running at once are indistinguishable — pass the stable identifier the harness gives the builder it spawns.
- **The station is a word the wall holds — `plan`, `build`, `review` or `ship` — never the line running it.** `dim-line-feat` and `dim-line-fix` are the line, not the station; the station is where the work is, and `dim order move <order-id> --station <name>` records it changing as the work moves through planning, building and review.
- Record evidence as it happens, not at the end: `dim order commit`, `dim order file`, `dim order check`, `dim order finding` and `dim order document` each take the order id and what was produced. `dim order file` takes `--added` and `--removed` straight from `git diff --numstat`, which is where the card's `+/−` comes from; pass the `-` numstat gives a binary file through as it stands rather than counting it zero. An order that records nothing leaves a card with nothing on it; `dim q factory <order-id-prefix>` reads back what was recorded.
- **Stop exactly once, whatever happened**: the item landed (`completed`), it waits on something else (`blocked`), a fence stopped it (`fenced`, with the shape as the reason), or it did not reach its outcome for any other reason, from a builder that failed to work dropped before it started (`failed`, with the reason saying which). A stopped order is refused a second lifecycle event, so a retry is a new order id. `dim order stop <order> completed` is refused unless a check recorded after the order's last commit passed and that commit reaches the trunk — the gate reads git out of the order's own worktree, so merge the work, then stop the order, then remove the worktree; removing it first makes completion impossible.

## The fence

Three shapes stop a run wherever they are met, including partway into an item that read as ready:

- work that is hard to reverse
- work that is outward-facing — a push to a shared branch, a comment on someone's issue, anything leaving this machine
- a change that spends something on every session rather than this one

A queue may draw its own fence on top of these — a section its rules file marks as the owner's call, a label, a state. Read it as binding and never move it: the owner moves a fence by editing the queue, not by an agent deciding an item looked fine.

Stopping means writing down what was found, leaving the item where it was, naming which shape stopped it, and stopping the order as `fenced` with that shape as the reason. Waiting for permission mid-run is not running unattended; deciding one of these alone is what the fence exists to prevent.

## Keep the line moving

**Work the queue until it is empty.** Take the next item the moment one lands, and do not come back between items to say a thing went well — a line that halts after every order is not running, and a report per item is the report at the end read one piece at a time.

The skill may be invoked repeatedly by whatever is driving it. Each invocation starts by reading the current floor and queue state; it never assumes that an earlier invocation finished, failed, or released an item. An active order is observed rather than claimed again. Independent items may run in parallel only when their claims are isolated; claiming, integration and queue-state transitions remain serialized. Repetition never crosses a fence or turns an unrecorded outcome into success.

Four things stop it, and nothing else does:

- a fence, per above
- the item count, when one was given as an argument
- **the same item failing twice** — a second failure says the item is wrong, not the attempt, so leave it and take the next one
- **two items failing in a row** — that is the floor moving rather than the items, and the next thing to do is read why rather than start a third

A failed attempt usually leaves the queue exactly as it was, so nothing but these keeps a run from taking the same item forever.

## Report

Per item, landed or not:

- the item taken, quoted, and the queue it came from
- the order id and the status it stopped at
- where it went, and the commits
- what `dim q findings` recorded for the slice
- what stopped the run, and which shape it was

A run that took nothing and says why is a complete run. A queue with no startable item is a finding about the queue.

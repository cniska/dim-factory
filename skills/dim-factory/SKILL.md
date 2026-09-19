---
name: dim-factory
description: Run a repo's queue — read the orders that repo has waiting, take the next one nobody holds, route it to the station that fits, and stop at a hold. Use to work a backlog without being handed a subject.
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

1. **The repo's own queue**, which `dim order ready` prints. It is keyed on the checkout's `owner/repo`, so the queue is the project's rather than the directory's, and `--project <owner/repo>` works another one deliberately.
2. **The argument is the queue**, when one is given. `/dim-factory docs/backlog.md` works that document and a tracker query works those issues. Nothing is discovered and nothing else is read as a queue.
3. **Two plausible queues is a question, not a coin flip.** Name both and stop.

**The rows state their own work, so nothing about one is retyped.** `dim order ready [--limit <n>]` prints every order nobody holds as JSON — its `id`, `title`, one-sentence `description`, `priority` and `status` — most urgent first and oldest before newest within a priority, with the held ones listed beside them. `dim order add` puts a new order in, including one found mid-slice.

Reading a tracker is your own tools' business — `dim` holds no credential and reaches no network, and nothing here changes that.

## Take an order

Take the first order that is **unheld and statable in one sentence**. A queue that marks its own blockers is telling you where to start; one that does not means reading enough of each item to know.

`dim order ready` is that list, in the order to take them: an order it does not print is either held for the owner or already taken, and either way is not yours. Where a document carries the argument for the same ids, read the taken item's section there for a hold before starting.

An order you cannot state needs scoping, which is `dim-station-plan` — run it, leave the sharpened order in the queue, and stop there.

| the order | the entry point |
|---|---|
| adds functionality | `dim-line-feat` |
| repairs something wrong | `dim-line-fix` |
| neither — a refactor, a doc, a rule | `dim-station-build` |

**Hand the order to a builder**, at the tier `dim route builder` gives you. Pass the order, base revision and repo check; the builder creates its isolated worktree with `dim wt <branch>`, then invokes the station itself and takes the order end to end. Running the station in this session makes the line one worker long, and then the queue is worked one item per invocation whatever this file says about emptying it.

This is not the fan-out `dim-station-build` argues against. That rule keeps a single slice from being split across agents, because edits need the context that produced them — a builder holding one whole order has exactly that context. What it forbids is two agents editing one slice.

Give the builder the order as the row states it, the repo's check, and the standing instruction to run its station's loop including the checking agent. Take back what it reports: the commits, the findings, what it left. A builder that returns without a commit and without saying why is a failed attempt, and the bound below counts it.

## Record the order

Every order taken is claimed before a builder sees it and stopped once whatever happened. Work done without a claim is work nobody watching can see, and a claim that never stops is a card left on the floor.

Mint one run id per invocation — `run-$(date -u +%Y%m%dT%H%M%SZ)`. The order id already exists: it is what `dim order ready` printed, and it is also the branch and the worktree directory the work is built in.

```
dim order claim <order-id> --run <run-id> \
  --station <plan|build|review|ship> [--session <id>]
dim order move <order-id> --station <plan|build|review|ship>
dim order stop <order-id> <completed|failed> [--reason "..."]
```

- **The id, the title and the statement come from the row, not from you.** A claim takes the order by its id and nothing else; the words are already on it, so nothing can record a second version of them.
- **A claim is also the start.** The order existed before the worker did, so taking it is starting it and there is no separate step.
- The branch and the worktree are the order id: `dim wt <order-id>` makes the worktree the builder works in, and nothing stores the path.
- **The worker comes from the environment, never from a flag.** `DIM_WORKER_NAME` and `DIM_WORKER_TOKEN` are what the factory hands a worker it starts, and every `dim order` write reads them and records that name on the moment. A shell that was started by nothing becomes a worker with `eval "$(dim worker mint --role builder)"`; without one, every write is refused rather than recorded against nobody.
- **The station is a word the wall holds — `plan`, `build`, `review` or `ship` — never the line running it.** `dim-line-feat` and `dim-line-fix` are the line, not the station; the station is where the work is, and `dim order move <order-id> --station <name>` records it changing as the work moves through planning, building and review.
- Record evidence as it happens, not at the end: `dim order commit`, `dim order file`, `dim order check`, `dim order finding` and `dim order document` each take the order id and what was produced. `dim order file` takes `--added` and `--removed` straight from `git diff --numstat`, which is where the card's `+/−` comes from; pass the `-` numstat gives a binary file through as it stands rather than counting it zero. An order that records nothing leaves a card with nothing on it; `dim q factory <order-id-prefix>` reads back what was recorded.
- **Stop exactly once, whatever happened**: the work landed (`completed`), or it did not (`failed`, with the reason saying why). A failure puts the order back among the work nobody holds, carrying its reason, so taking it again is an ordinary claim rather than a new card. `dim order stop <order> completed` is refused unless a check recorded after the order's last commit passed and that commit reaches the trunk — the gate reads git out of the worktree the command is typed in, so merge the work, then stop the order, then remove the worktree; removing it first makes completion impossible.
- Work found mid-slice goes in with `dim order add`, so a run that surfaces "we should also do X" ends in a row rather than a paragraph nobody reads.

## The hold

Three shapes stop a run wherever they are met, including partway into an order that read as ready:

- work that is hard to reverse
- work that is outward-facing — a push to a shared branch, a comment on someone's issue, anything leaving this machine
- a change that spends something on every session rather than this one

A queue may add a hold of its own on top of these — a section its rules file marks as the owner's call, a label, a state. Read it as binding and never lift it: the owner releases a hold on the row, not an agent deciding an order looked fine.

Stopping means writing down what was found, leaving the order where it was, naming which shape stopped it, then `dim order hold <order-id> --reason "<shape>"` and stopping it as `failed`. Waiting for permission mid-run is not running unattended; deciding one of these alone is what the hold exists to prevent.

## Keep the line moving

**Work the queue until it is empty.** Take the next order the moment one lands, and do not come back between items to say a thing went well — a line that halts after every order is not running, and a report per order is the report at the end read one piece at a time.

The skill may be invoked repeatedly by whatever is driving it. Each invocation starts by reading the current floor and queue state; it never assumes that an earlier invocation finished, failed, or released an item. An order already held is observed rather than claimed again. Independent orders may run in parallel only when their claims are isolated; claiming and integration remain serialized. Repetition never crosses a hold or turns an unrecorded outcome into success.

Four things stop it, and nothing else does:

- a hold, per above
- the order count, when one was given as an argument
- **the same order failing twice** — a second failure says the order is wrong, not the attempt, so leave it and take the next one
- **two orders failing in a row** — that is the floor moving rather than the orders, and the next thing to do is read why rather than start a third

A failed attempt usually leaves the queue exactly as it was, so nothing but these keeps a run from taking the same item forever.

## Report

Per order, landed or not:

- the order taken, quoted, and the project it belongs to
- the order id and the status it stopped at
- where it went, and the commits
- what `dim q findings` recorded for the slice
- what stopped the run, and which shape it was

A run that took nothing and says why is a complete run. A queue with no startable order is a finding about the queue.

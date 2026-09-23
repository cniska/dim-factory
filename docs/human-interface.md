# Human interface

The factory's human interface is a local, read-only wall that makes current work, risk and progress clear without requiring a conversation with the operator.

## The wall

The first interface is a Bun-hosted React page served on loopback. It reads the persisted factory records and updates through a read-only WebSocket stream. It has no control endpoints and does not become a second state store.

The wall is read by a person; the identifiers are read by agents. A card carries the words someone recognizes from across the room, and the ids that a query joins on stay in the queries. Where the same fact has a human form and a machine form, the wall shows the human one.

The client is a React static bundle that Bun serves. Its CSS custom properties are the single visual token source, and its small card, badge and button primitives follow the shadcn/ui component shape with Lucide icons. Next.js is outside the first slice: the local server and the client have separate responsibilities, and the wall does not need a second application server.

## Implementation

The client uses semantic HTML, CSS variables, a dark responsive layout, lightweight client state, bounded lists and fullscreen presentation. Its base palette is black, white and grayscale surfaces; semantic accents are reserved for agent roles and order states. Bun serves the React bundle beside the local read-only server. The interface owns its visual system and has no control surface.

The page answers one question: where is each item in the factory flow? A three-column board puts every item in Todo, Active or Done, the stage every item shares whatever kind of work it is. An order that has been claimed but not started is Todo; a working order is Active; a completed or failed order is Done. A blocked or held order stays in Active: it has not reached an outcome, and a stuck item is what a wall exists to show. Each fixed-size card carries the item's title, its station, stage and the worker it is recorded against. Blocked, held and failed orders keep their operational warning on the card.

Column headers carry the column's whole count, not the number of cards drawn, and a column holding more work than it can draw says how many it left out. Empty columns retain only their heading and count so the board stays quiet.

The station — Plan, Build, Review or Ship — is card metadata rather than a column, so the board reads as progress rather than as a floor plan, and two items at the same station can sit in different columns.

The board is a snapshot assembled from factory order and lifecycle event records. The board itself stays an overview and does not grow into a table.

The wall has three questions, in this order:

1. **What needs attention?** Holds, blockers, repeated failures, stale work, missing contracts, and a stopped floor.
2. **Where is the work?** Project, stage, station, worker, current attempt, and time since the last event.
3. **Is the floor healthy?** Feed connection, active operator, active workers, due scheduled reviews, and counts of work waiting, moving, held, failed, and complete.

The first viewport shows the first two questions. Floor health stays in a compact header or status rail; it does not become a dashboard of derived metrics. A card may add project identity, attempt count, and the current owner action when those facts exist. It does not show the audit log, changed-file list, call graph, or plan body.

## Visual language

- **Dark ground.** A stable dark surface keeps status colors and text legible for a display that may stay open.
- **Dim presence.** Graphite and charcoal surfaces, softened white hierarchy and low-saturation accents keep the wall calm, precise and instrument-like; neon, glossy and high-energy treatment does not belong here.
- **Monospace type.** JetBrains Mono, falling back to the platform's monospace face, keeps identifiers, timestamps and counts aligned and gives the wall its instrument register. No web font is fetched.
- **Compact cards.** Each card carries the item it names, how long it has been silent, and the smallest useful supporting detail.
- **Strong hierarchy.** Current state is bright and large; age, identity and provenance are quieter.
- **Status as information.** Color marks active, healthy, blocked, failed, held and stale states, with text always carrying the meaning.
- **Age is visible.** The newest event leads; older events recede without disappearing.
- **No ornamental motion.** The wall uses text and state markers to show change without decorative animation.
- **Responsive and fullscreen.** The same wall works as a browser page and as a display viewed from across a room.

## Acceptance

The implementation is reviewed against seeded snapshots covering all three columns; the working, waiting, blocked, held, completed and failed states; every station; and each agent role. The first viewport must make the work, station, state and worker identity legible without opening a detail view.

The implementation lives in `src/factory-wall.ts`, `src/wall-board.ts`, `src/wall-client.tsx`, `src/wall.html` and `src/wall.css`. `dim wall` serves the page on loopback at one address every run, so a link to the board keeps working across the restarts that pick up a change; `DIM_WALL_PORT` names another, and a value that is not a port refuses rather than serving somewhere the reader is not looking. Bun bundles the page from the HTML route, so `dim wall --dev` adds hot reload without a second way of being served; `GET /api/snapshot` reads the existing database, `GET /api/order/<order-id>` reads one order's whole record, and `/ws` sends a changed snapshot. When the database is unavailable, the wall states that condition rather than rendering fabricated operational rows.

The review checks the same wall at a 1440×900 fullscreen desktop viewport and below it. Surfaces use one shared token set, edges and gaps align, text remains readable when the browser enlarges it, and no state depends on color alone. The snapshot, stale-feed state and role markers remain understandable when the connection stops. An independent screenshot review is required in addition to automated checks; a passing test suite does not establish visual quality.

## Factory character

The wall should feel like a software production floor:

- **Stations are visible.** Every card names the station its order is at; an order's current station is immediately clear without the layout being built around it.
- **Work-in-progress is concrete.** An order card names the item, its station, stage and worker; what it counts is the order's own failed checks, and everything else it accrued waits in the item view.
- **Flow is legible.** The page shows work moving from Todo through Active to Done and makes a stopped item interrupt that flow visually.
- **Stopped work says why.** The reason an order cannot move is on the card, without opening raw logs.
- **Quality is part of the surface.** Checks, review findings, setup state and holds sit beside progress rather than behind a separate admin page.
- **The page is calm.** Strong spacing, a small status palette and deliberate typography make the important exception visible without making the whole screen look urgent.
- **Roles have a visual code.** An order's marker is tinted for its role: planner, builder and reviewer each have a stable tint. The marker's accessible name states the role in words; the tint does not identify a model. The station remains a separate label.
- **The recorded station is what a role is read from.** It is the one thing that says what kind of work an order is doing. Ship is work none of the roles names, and an unknown station says nothing about the role, so both leave the role unknown. An unknown role takes no tint, and its marker's name says the role is unknown.
- **Theme resolves meaning.** Semantic roles such as `builder`, `reviewer`, `planner`, `working`, `blocked` and `failed` are chosen by the layout and resolved by one fixed theme. Agent-role styling and order-state styling stay separate, so a role color never has to carry state as well.

## Order identity

Every card on the board carries the same compact identity block:

- **What.** The item's title, in the words the queue states it in. The item id stays in the record for an agent to join on.
- **Where.** The current station, named on the card. Plan, Build, Review and Ship are reserved for the words the record actually holds; an order claimed with anything else, or with no station at all, reads as unknown.
- **Who.** Agent identity, with the agent's role carried by a marker and by the written role. An order that no claim or event named an agent for shows no worker, rather than a name that would read as a worker and collide with every other unattributed order.
- **Status.** Working, waiting, blocked, held, completed or failed.
- **Why stopped.** For an order that cannot move, its stop reason or hold.
- **How long it has been silent.** Time since the order's last recorded event, which is also what orders a column. An unattended run fails by going quiet, so the one figure on the card counts from the last thing that happened to the order.

These values come from persisted order claims and lifecycle events. The wall does not infer activity from a process name or a stale heartbeat, and it does not infer what kind of work an item is from its title: it shows the metadata the factory recorded.

A card states what its column does not. A value repeated down a whole column is a constant, which is the rule that keeps the operator out of the cards: Todo is where an order waits, Active is where a worker holds one and Done is where a completed one ends, so those cards carry the state as a marker alone and name it only to a reader who is not looking at the column. What keeps its word is what a column cannot say — blocked, held, failed — which are the cards that want a person.

The title is the one thing a card may not lose, so it wraps to a second line rather than being cut, and stops there: two rows of the card's rhythm hold the titles a queue writes and keep one long title from growing its card past its neighbors. An invariant the lifecycle guarantees is the same rule one level up: a completed order's check passed, so a done card says nothing about checks. The one piece of evidence a card carries is a working order's failed checks, one mark each, because an order failing its check repeatedly is struggling and that is what the owner would otherwise have to open the item view to see. Everything else the order accrued — its commits, files, findings, checks and history — is reading rather than glancing, and lives in the item view.

That an outcome implies a green check is a rule the board leans on and nothing enforces: the operator records `completed` itself and could record it over a red check. [`build-order.md`](build-order.md) carries the gate that would hold it.

An order the owner has to answer — blocked, held or failed — is ranked above the moving work before a column is bounded, so it holds its place on the board and a column read from the top reads as what needs a person and then as what is in flight. A stopped order records nothing further, so ordering by silence alone would sink it under everything still running and a bound would drop it first.

## The item view

A card answers where an item is; the item view answers what happened to it. Opening one card shows that order alone, and the board stays an overview rather than growing columns to hold the detail.

It is a dialog over the board, the shape a detail surface already takes in this owner's other work: a titled header, the order's facts in a term-and-value grid, and the content below it. Two things differ. It is sized for reading rather than for a form, so a history as long as the order was fits without the dialog outgrowing the viewport — the dialog holds its size and its content scrolls, and the Plan, Build and Review sections below will have the same room. And it carries no action row, because opening a record is the whole of what it does.

The dialog is a decision surface, not only an audit-log viewer. In addition to the audit log and changed-file list, it shows the following sections in this order:

- **Current decision.** State, station, project, owner action, active hold or blocker, current attempt, silence age, and the latest check or finding that explains the state.
- **Intent.** Queue statement, approved plan revision, approval state, risks, non-goals, and the implementation outline. The queue statement is what was requested; the plan is what the order decided to do about it.
- **Build.** The Summary artifact: an independent explanation of what was built, why it has this shape, what risks remain, and where it differs from the approved plan. It links to the exact commits, final check, integration state, and owner verdict. It appears only when the order is ready; until then, the dialog shows the Plan and evidence that explain the current state.
- **Review.** The review artifact and its attributed findings, showing why the order may advance or must return. It appears once review has been delegated.
- **Program design.** The bounded file tree, key signatures, call path, data flow, and planned boundary crossings. Show the graph collapsed by default; expand it when the owner is investigating a scope or architecture question.
- **Execution summary.** Attempts, loop iterations, failed checks, review rounds, simplification fixpoints, worker and operator attribution, model or tier where recorded, and setup or teardown state.
- **Audit log.** The immutable lifecycle sequence, including claims, station moves, delegations, checks, findings, documents, environment reports, outcomes, and integration.
- **Changes.** The changed-file set with added and removed lines, kept separate from the time-ordered story.

The first three sections answer whether the order is understood, what it intended, and what it delivered. The remaining sections provide proof. Raw transcript text is not part of the default view; a source reference may be offered when an evidence row needs investigation.

Covering the board is the right trade: reading one item is a deliberate act at the machine, while the board is what carries the room. The view stays live while it is open, re-reading the record on every beat the board reports for that order.

- **One item.** The view opens from a card and shows that order's own record. It is a place to look at one thing, not a table of everything, and the board is still the way to find it.
- **Its history, in order.** The lifecycle events as they were written: claimed, started, each move to another station, delegated, each commit, each check, each finding, and the outcome. The order is the story, so it reads down the page rather than being grouped by kind.
- **What it took to get there.** Repeated checks and repeated review rounds are visible as repetition rather than collapsed into a final state, so an item that passed on the first attempt reads differently from one that took four. A refused finding shows the grounds it was refused on.
- **Its evidence, attached.** The commits with their subjects, the checks with their commands and exit status, the findings with their dimension and the grounds a refusal rested on, the documents the order updated, and what a worktree's setup and teardown hooks reported. A commit, a check and a finding are written with the event that produced them and sit with it; a document and an environment report are written without one and stand in the record where their own time puts them.
- **What it changed, beside the history.** The files the order recorded, each with the lines it added and removed, as their own list rather than as moments in the story: a builder that touches twenty files would otherwise bury the events among them, and what changed is read as a set. A count nobody recorded is left blank, since zero lines changed is a different claim — a path recorded before counts were written, and a binary file git reports no counts for, both read that way.
- **Human words, machine ids.** The same split the board follows: the item's title and its description lead, in the words the queue stated them in and as the claim recorded them, and the order id, item id, branch, worktree and commit shas are present for an agent to join on. A sha is shortened to what a person compares and carries the whole of itself for anything that reads the page.

The order's identity stays above whatever is being read — which item, which station, which worker, which state — because it answers "what am I looking at" and a reader who has to go back for it has lost the thread. It is the card's own identity, on screen from the moment the dialog opens rather than once the record arrives, and a record that cannot be read says so instead of reading as one still loading. Below it the reports divide: what the order set out to do, what it did, and what it built. Each is a document in its own right and long enough that stacking them makes the one being read hard to find.

The dialog does not put every section at the same visual weight. Current decision stays open; intent and result are the primary comparison; program design and execution summary are deliberate disclosures; the audit log and changes remain available for verification. This preserves the wall's glanceable role while making a single order understandable without returning to the transcript.

Beside the history runs the order's timeline, in the order things happened, with the time each one occurred and the worker the record names for it. It is the audit record in its most compact form — what happened, who was named for it, who they handed to, and when — and it answers at a glance the question the reports answer at length. Most moments name no agent today, because only a claim, a start and a delegation are recorded against one; a stop the record leaves unattributed stays unattributed here rather than borrowing the worker beside it.

Keeping it lean is what makes it readable: the rail carries a mark, a worker and a time, and nothing else. An event's words belong to the report it came from, so a rail that starts quoting them becomes a second copy of the history it indexes. The marks stay uniform, so four review rounds read as four marks rather than four paragraphs, and a delegation reads as the handover it was — one agent's run ending where another's begins. The rail and the history are one list in two columns, because two lists side by side drift apart at the first line that wraps and the rail stops indexing what it sits beside.

The wall's primitives are small and its runtime dependencies are few, so the dialog is worth building on the platform's own `<dialog>` element, which carries modality, focus and dismissal already. Pulling in a component library for one surface would cost more than the surface. Escape and a click on the backdrop both close it, and neither states itself, so a close control sits in the header beside the title: the one way out a reader does not have to already know.

`dim q order <order-id>` already reads this record from the same tables, so the view renders what that query reads rather than assembling a second account of an order. Where the two would disagree, the query is the one to fix.

### Reviewing before and after

Planned. An item view shows what happened; these two let the owner judge it without reading a transcript. Both already have writers and neither has a home: the plan comes from the planning station, the account from reading the built diff, and both currently end in a transcript.

They belong on one surface, against each other, however the rest of the view divides. Their value is where they disagree — scope that grew, a slice never built — and a difference nobody can see is a difference nobody finds.

- **The plan, before.** What the order intends to build, in the words a person would use, written when the item is claimed and not edited afterward. A plan that can be revised once the work is done can always be made to match the work, so its value comes from being fixed at claim time and attached to the order rather than to a session. It is not the item's description, which the claim already records: that is what the queue asked for, while the plan is what the order means to do about it, and the gap between them is the thing worth reading.
- **The Build, after.** What the order actually built, read off its diff. It names the commits it describes, because a generated Summary is indistinguishable from a checked one after the fact, and `factory_order_commit` with `factory_order_file` stay the record a reader can verify it against.
- **The difference between them.** The review artifact is where the two disagree: work that appeared, scope that grew, a slice planned and never built. Holding both against the same order and the same slice identity makes that a query rather than a reading exercise.

Writing an account of every diff spends on every order rather than on one, which makes it a decision the owner takes once rather than a step an agent adds.

## The operator

The board shows the work; the operator is who is driving the floor. An order's agent is already on its card, so the operator is the one identity a card cannot carry: while a single harness drives a run, repeating it on every card states a constant down all three columns.

- **Where.** In the header, beside the feed state. Both describe the run as a whole rather than any one item, and the pairing reads as one line: this floor is being driven, and the feed is live.
- **Mark.** A robot, as the cards use, left untinted. A tint states a role and the operator has none; the header is what sets the mark apart from a worker's.
- **When it moves to the card.** Only once several operators can drive one factory at the same time, which [`factory.md`](factory.md) designs and bounds. Until then a per-card operator is a repeated constant.
- **Absent is a state.** A floor with no clocked-in operator says so, rather than showing the last one that was seen.

[`factory.md`](factory.md) owns what an operator is and how presence is recorded; this page owns only where it appears.

## Scale

The wall remains an overview as the factory grows:

- **Columns absorb volume.** Each stage column draws its most recently updated work in bounded cards rather than expanding into a history list, and is bounded on its own, so a growing Done column cannot push Active work off the board.
- **Details stay on the card.** The item's title, station, state and the worker it is recorded against are visible without turning the wall into a table.
- **The transport stays quiet.** WebSocket updates send changed snapshots or bounded deltas, not an ever-growing event log.
- **The layout adapts.** The same hierarchy works as a fullscreen wall, a wide desktop page and a narrow browser window.

## Read-only boundary

The page may observe but never claim, retry, pause, resume, cancel, ship, remove, push or alter a schedule. The server binds to `127.0.0.1`; its HTTP routes return the board's snapshot and one order's record, and its WebSocket sends snapshots when they change. Client messages are rejected or ignored.

Controls are expected here eventually, and the boundary holds until the factory has shown which decisions recur often enough to earn one. Watching answers that; guessing at it produces buttons for moments that turn out to be rare. What a control would have to satisfy is set out under [Human attention](#human-attention).

## Human attention

The wall exposes holds, blockers and other places where the factory needs human attention. The dialog explains the reason and presents the evidence for that decision. The first human-facing states are:

- a plan awaiting approval
- an ambiguous or changed contract
- a repeated failed attempt or review finding
- a missing project or workspace contract
- a stale or silent order
- a factory stop or unsafe environment
- a result that differs from the approved plan
- a ship or owner verdict awaiting a decision

When a human shipping gate is enabled, Build is its default focus. Until then, the dialog exposes the Plan, Build and Review artifacts for observation while the operator continues through the mechanical shipping conditions.

These are visibility states, not controls. The wall remains read-only until the factory record shows which decisions recur often enough to earn a safe control surface.

## Server shape

```text
read-only database
        ↓
snapshot assembler → HTTP snapshot
        ↓                  ↓
      change hash ← WebSocket subscribers
        ↓
     wall page
```

The server separates Bun fetch handling, status-payload construction and WebSocket handling. Authentication, RPC commands and remote hosting are outside this interface.

## Design rule

Every visual element earns its place by answering what the owner needs to know about the factory now; a control, raw log or metric that does not change that decision stays in the read-only query surface.

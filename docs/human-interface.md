# Human interface

The factory's human interface is a local, read-only wall that makes current work, risk and progress clear without requiring a conversation with the driver.

## The wall

The first interface is a Bun-hosted React page served on loopback. It reads the persisted factory records and updates through a read-only WebSocket stream. It has no control endpoints and does not become a second state store.

The wall is read by a person; the identifiers are read by agents. A card carries the words someone recognizes from across the room, and the ids that a query joins on stay in the queries. Where the same fact has a human form and a machine form, the wall shows the human one.

The client is a React static bundle that Bun serves. Its CSS custom properties are the single visual token source, and its small card, badge and button primitives follow the shadcn/ui component shape with Lucide icons. Next.js is outside the first slice: the local server and the client have separate responsibilities, and the wall does not need a second application server.

## Implementation

The client uses semantic HTML, CSS variables, a dark responsive layout, lightweight client state, bounded lists and fullscreen presentation. Its base palette is black, white and grayscale surfaces; semantic accents are reserved for agent roles and job states. Bun serves the React bundle beside the local read-only server. The interface owns its visual system and has no control surface.

The page answers one question: where is each item in the factory flow? A three-column board puts every item in Todo, Active or Done, the lifecycle every item shares whatever kind of work it is. A job that has been claimed but not started is Todo; a running job is Active; a completed, failed or abandoned job is Done. A blocked or fenced job stays in Active: it has not reached an outcome, and a stuck item is what a wall exists to show. Each fixed-size card carries the item, its station, lifecycle state and worker identity. Blocked, fenced, failed and abandoned jobs keep their operational warning on the card.

Column headers carry the column's whole count, not the number of cards drawn, and a column holding more work than it can draw says how many it left out. Empty columns retain only their heading and count so the board stays quiet.

The station — Plan, Build, Review or Ship — is card metadata rather than a column, so the board reads as progress rather than as a floor plan, and two items at the same station can sit in different columns.

The board is a snapshot assembled from factory job and lifecycle event records. The board itself stays an overview and does not grow into a table.

## Visual language

- **Dark ground.** A stable dark surface keeps status colors and text legible for a display that may stay open.
- **Dim presence.** Graphite and charcoal surfaces, softened white hierarchy and low-saturation accents keep the wall calm, precise and instrument-like; neon, glossy and high-energy treatment does not belong here.
- **Monospace type.** JetBrains Mono, falling back to the platform's monospace face, keeps identifiers, timestamps and counts aligned and gives the wall its instrument register. No web font is fetched.
- **Compact cards.** Each card carries one fact, a short explanation and the smallest useful supporting detail.
- **Strong hierarchy.** Current state is bright and large; age, identity and provenance are quieter.
- **Status as information.** Color marks active, healthy, blocked, failed, fenced and stale states, with text always carrying the meaning.
- **Age is visible.** The newest event leads; older events recede without disappearing.
- **No ornamental motion.** The wall uses text and state markers to show change without decorative animation.
- **Responsive and fullscreen.** The same wall works as a browser page and as a display viewed from across a room.

## Acceptance

The implementation is reviewed against seeded snapshots covering all three columns; the running, waiting, blocked, fenced, completed, failed and abandoned states; every station; and each agent role. The first viewport must make the work, station, state and worker identity legible without opening a detail view.

The implementation lives in `src/factory-wall.ts`, `src/wall-board.ts`, `src/wall-client.tsx`, `src/wall.html` and `src/wall.css`. `dim wall` serves the page on loopback and Bun bundles it from the HTML route, so `dim wall --dev` adds hot reload without a second way of being served; `GET /api/snapshot` reads the existing database, and `/ws` sends a changed snapshot. When the database is unavailable, the wall states that condition rather than rendering fabricated operational rows.

The review checks the same wall at a 1440×900 fullscreen desktop viewport and below it. Surfaces use one shared token set, edges and gaps align, text remains readable when the browser enlarges it, and no state depends on color alone. The snapshot, stale-feed state and role markers remain understandable when the connection stops. An independent screenshot review is required in addition to automated checks; a passing test suite does not establish visual quality.

## Factory character

The wall should feel like a software production floor:

- **Stations are visible.** Plan, Build, Review and Ship are named on every card; a job's current station is immediately clear without the layout being built around it.
- **Work-in-progress is concrete.** A job card names the item, its station, lifecycle state and worker instead of showing abstract activity counts.
- **Flow is legible.** The page shows work moving from Todo through Active to Done and makes a stopped item interrupt that flow visually.
- **Stopped work says why.** The reason a job cannot move is on the card, without opening raw logs.
- **Quality is part of the surface.** Checks, review findings, setup state and fences sit beside progress rather than behind a separate admin page.
- **The page is calm.** Strong spacing, a small status palette and deliberate typography make the important exception visible without making the whole screen look urgent.
- **Roles have a visual code.** Agent roles may tint a rail and job marker: builder, fixer, reviewer and planner each have a stable visual role. The written role and a shape or icon carry the meaning too; the code does not identify a model or rely on color alone. The station remains a separate label.
- **Theme resolves meaning.** Semantic roles such as `builder`, `fixer`, `reviewer`, `planner`, `running`, `blocked` and `failed` are chosen by the layout and resolved by one fixed theme. Agent-role styling and job-state styling stay separate, so a role color never has to carry state as well.

## Job identity

Every card on the board carries the same compact identity block:

- **What.** The item's title, in the words the queue states it in. The item id stays in the record for an agent to join on.
- **Where.** The current station, named on the card.
- **Who.** Agent identity, with the agent's role carried by a marker and by the written role.
- **State.** Running, waiting, blocked, fenced, completed, failed or abandoned.
- **Why stopped.** For a job that cannot move, its stop reason or fence.

These values come from persisted job claims and lifecycle events. The wall does not infer activity from a process name or a stale heartbeat, and it does not infer what kind of work an item is from its title: it shows the metadata the factory recorded.

## The item view

Planned. A card answers where an item is; the item view answers what happened to it. Opening one card shows that job alone, and the board stays an overview rather than growing columns to hold the detail.

It is a dialog over the board, the shape a detail surface already takes in this owner's other work: a titled header, the job's facts in a term-and-value grid, and the content below it. Two things differ. It is sized for reading rather than for a form, so the plan, the ordered history and the account fit without the dialog outgrowing the viewport — the dialog holds its size and its content scrolls. And it carries no action row, because opening a record is the whole of what it does.

Covering the board is the right trade: reading one item is a deliberate act at the machine, while the board is what carries the room. A dialog is also the reason the view can be live without being noisy — the board behind it keeps moving, and the reader is looking at one thing on purpose.

- **One item.** The view opens from a card and shows that job's own record. It is a place to look at one thing, not a table of everything, and the board is still the way to find it.
- **Its history, in order.** The lifecycle events as they were written: claimed, started, delegated, each commit, each check, each finding, and the outcome. The order is the story, so it reads down the page rather than being grouped by kind.
- **What it took to get there.** Repeated checks and repeated review rounds are visible as repetition rather than collapsed into a final state, so an item that passed on the first attempt reads differently from one that took four. A refused finding shows the grounds it was refused on.
- **Its evidence, attached.** The commits with their subjects, the files they touched, the checks with their commands and exit status, the findings with their dimension, and the documents the job updated. Each sits with the event that produced it.
- **Human words, machine ids.** The same split the board follows: the title and the plain description lead, and the job id, item id and commit shas are present for an agent to join on.

The job's identity stays above whatever is being read — which item, which station, which worker, which state — because it answers "what am I looking at" and a reader who has to go back for it has lost the thread. Below it the reports divide: what the job set out to do, what it did, and what it built. Each is a document in its own right and long enough that stacking them makes the one being read hard to find.

The plan and the account are the exception, and putting them in separate places is the way to lose what they are for. Their value is where they disagree — scope that grew, a slice never built — and a difference nobody can see is a difference nobody finds. They belong on one surface, against each other, however the rest divides.

Beside the reports runs the job's timeline: every agent that touched it, in the order it happened, with the time each thing occurred. It is the audit record in its most compact form — who operated, who they handed to, and when — and it answers at a glance the question the reports answer at length.

Keeping it lean is what makes it readable: the rail carries a mark, a worker and a time, and nothing else. An event's words belong to the report it came from, so a rail that starts quoting them becomes a second copy of the history it indexes. The marks stay uniform, so four review rounds read as four marks rather than four paragraphs, and a delegation reads as the handover it was — one agent's run ending where another's begins.

The wall's primitives are small and its runtime dependencies are few, so the dialog is worth building on the platform's own `<dialog>` element, which carries modality, focus and dismissal already. Pulling in a component library for one surface would cost more than the surface.

`dim q job <job-id>` already reads this record from the same tables, so the view renders what that query reads rather than assembling a second account of a job. Where the two would disagree, the query is the one to fix.

### Reviewing before and after

Planned. An item view shows what happened; these two let the owner judge it without reading a transcript. Both already have writers and neither has a home: the plan comes from the planning station, the account from reading the built diff, and both currently end in a transcript.

- **The plan, before.** What the job intends to build, in the words a person would use, written when the item is claimed and not edited afterward. A plan that can be revised once the work is done can always be made to match the work, so its value comes from being fixed at claim time and attached to the job rather than to a session.
- **The account, after.** What the job actually built, read off its diff. It names the commits it describes, because a generated account of a change is indistinguishable from a checked one after the fact, and `factory_job_commit` with `factory_job_file` stay the record a reader can verify it against.
- **The difference between them.** The review artifact is where the two disagree: work that appeared, scope that grew, a slice planned and never built. Holding both against the same job and the same slice identity makes that a query rather than a reading exercise.

Writing an account of every diff spends on every job rather than on one, which makes it a decision the owner takes once rather than a step an agent adds.

## The operator

The board shows the work; the operator is who is driving the floor. A job's agent is already on its card, so the operator is the one identity a card cannot carry: while a single harness drives a run, repeating it on every card states a constant down all three columns.

- **Where.** In the header, beside the feed state. Both describe the run as a whole rather than any one item, and the pairing reads as one line: this floor is being driven, and the feed is live.
- **Mark.** A robot, as the cards use, left untinted. Role tints belong to workers, so an operator that takes no tint reads as standing outside them without adding a color meaning.
- **When it moves to the card.** Only once several operators can drive one factory at the same time, which [`factory.md`](factory.md) designs and bounds. Until then a per-card operator is a repeated constant.
- **Absent is a state.** A floor with no clocked-in operator says so, rather than showing the last one that was seen.

[`factory.md`](factory.md) owns what an operator is and how presence is recorded; this page owns only where it appears.

## Scale

The wall remains an overview as the factory grows:

- **Columns absorb volume.** Each lifecycle column draws its most recently updated work in bounded cards rather than expanding into a history list, and is bounded on its own, so a growing Done column cannot push Active work off the board.
- **Details stay on the card.** The item, station, state and worker identity are visible without turning the wall into a table.
- **The transport stays quiet.** WebSocket updates send changed snapshots or bounded deltas, not an ever-growing event log.
- **The layout adapts.** The same hierarchy works as a fullscreen wall, a wide desktop page and a narrow browser window.

## Read-only boundary

The page may observe but never claim, retry, pause, resume, cancel, ship, remove, push or alter a schedule. The server binds to `127.0.0.1`; its HTTP routes return snapshots and its WebSocket sends snapshots when they change. Client messages are rejected or ignored.

Controls are expected here eventually, and the boundary holds until the factory has shown which decisions recur often enough to earn one. Watching answers that; guessing at it produces buttons for moments that turn out to be rare. What a control would have to satisfy is set out under [Human attention](#human-attention).

## Human attention

The wall exposes fences, blockers and other places where the factory needs human attention. The recurring decisions, their evidence and whether any response belongs in this interface are not known yet; the factory should reveal that shape before this page gains controls.

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

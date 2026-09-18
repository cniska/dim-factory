# Human interface

The factory's human interface is a local, read-only wall that makes current work, risk and progress clear without requiring a conversation with the driver.

## The wall

The first interface is a Bun-hosted React page served on loopback. It reads the persisted factory records and updates through a read-only WebSocket stream. It has no control endpoints and does not become a second state store.

The client is a React static bundle that Bun serves. Its CSS custom properties are the single visual token source, and its small card, badge and button primitives follow the shadcn/ui component shape with Lucide icons. Next.js is outside the first slice: the local server and the client have separate responsibilities, and the wall does not need a second application server.

## Implementation

The client uses semantic HTML, CSS variables, a dark responsive layout, lightweight client state, bounded lists and fullscreen presentation. Its base palette is black, white and grayscale surfaces; semantic accents are reserved for agent roles and job states. Bun serves the React bundle beside the local read-only server. The interface owns its visual system and has no control surface.

The page answers one question: where is each item in the factory flow? A three-column board puts every item in Todo, Active or Done, the lifecycle every item shares whatever kind of work it is. A job that has been claimed but not started is Todo; a running job is Active; a completed, failed or abandoned job is Done. A blocked or fenced job stays in Active: it has not reached an outcome, and a stuck item is what a wall exists to show. Each fixed-size card carries the item, its station, lifecycle state and worker identity. Blocked, fenced, failed and abandoned jobs keep their operational warning on the card.

Column headers carry the column's whole count, not the number of cards drawn, and a column holding more work than it can draw says how many it left out. Empty columns retain only their heading and count so the board stays quiet.

The station — Plan, Build, Review or Ship — is card metadata rather than a column, so the board reads as progress rather than as a floor plan, and two items at the same station can sit in different columns.

The board is a snapshot assembled from factory job and lifecycle event records. Detailed read-only queries remain the path for investigation; the wall does not reproduce their full reports.

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

- **What.** The item identity.
- **Where.** The current station, named on the card.
- **Who.** Agent identity, with the agent's role carried by a marker and by the written role.
- **State.** Running, waiting, blocked, fenced, completed, failed or abandoned.
- **Why stopped.** For a job that cannot move, its stop reason or fence.

These values come from persisted job claims and lifecycle events. The wall does not infer activity from a process name or a stale heartbeat, and it does not infer what kind of work an item is from its title: it shows the metadata the factory recorded.

## Scale

The wall remains an overview as the factory grows:

- **Columns absorb volume.** Each lifecycle column draws its most recently updated work in bounded cards rather than expanding into a history list, and is bounded on its own, so a growing Done column cannot push Active work off the board.
- **Details stay on the card.** The item, station, state and worker identity are visible without turning the wall into a table.
- **The transport stays quiet.** WebSocket updates send changed snapshots or bounded deltas, not an ever-growing event log.
- **The layout adapts.** The same hierarchy works as a fullscreen wall, a wide desktop page and a narrow browser window.

## Read-only boundary

The page may observe but never claim, retry, pause, resume, cancel, ship, remove, push or alter a schedule. The server binds to `127.0.0.1`; its HTTP routes return snapshots and its WebSocket sends snapshots when they change. Client messages are rejected or ignored.

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

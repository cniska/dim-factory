# Human interface

The factory's human interface is a local, read-only wall that makes current work, risk and progress clear without requiring a conversation with the driver.

## The wall

The first interface is a Bun-hosted React page served on loopback. It reads the persisted factory records and updates through a read-only WebSocket stream. It has no control endpoints and does not become a second state store.

The client uses shadcn/ui components and Tailwind design tokens, built as a static bundle that Bun serves. Next.js is outside the first slice: the local server and the client have separate responsibilities, and the wall does not need a second application server.

## Implementation

The client uses semantic HTML, CSS variables, a dark responsive layout, lightweight client state, deliberate animation, overview and detail separation, bounded lists, a recent-activity ticker, fullscreen presentation and an explicit stale-feed state. Its base palette is black, white and grayscale surfaces; semantic accents are reserved for agent roles and job states. It uses React, shadcn/ui and Tailwind as a static bundle; Bun serves it beside the local read-only server. The interface owns its visual system and has no control surface.

The page answers these questions in order:

- **What is happening?** Active jobs, their stations, worktrees and latest events.
- **What needs attention?** Fences, blockers, failed setup or teardown, stale workers and repeated failures.
- **What happens next?** Eligible queue work, due schedules and jobs waiting for serialized landing.
- **What just finished?** Recent terminal outcomes and the evidence attached to them.

The overview is a snapshot assembled from the existing queue, factory job, lifecycle event, schedule and worker-environment records. Detailed read-only queries remain the path for investigation; the wall does not reproduce their full reports.

## Visual language

- **Dark ground.** A stable dark surface keeps status colors and text legible for a display that may stay open.
- **Compact cards.** Each card carries one fact, a short explanation and the smallest useful supporting detail.
- **Strong hierarchy.** Current state is bright and large; age, identity and provenance are quieter.
- **Status as information.** Color marks active, healthy, blocked, failed, fenced and stale states, with text always carrying the meaning.
- **Age is visible.** The newest event leads; older events recede without disappearing.
- **No ornamental motion.** Animation marks a changed fact or a connection state, never decoration.
- **Responsive and fullscreen.** The same wall works as a browser page and as a display viewed from across a room.

## Acceptance

The first implementation is reviewed against a seeded snapshot containing plan, build and review work; running, waiting, blocked, fenced and completed states; and each agent role. The first viewport must make the work, station, agent, state and next meaningful action legible without opening a detail view.

The review checks the same wall at fullscreen desktop and narrow viewport sizes. Surfaces use one shared token set, edges and gaps align, text remains readable when the browser enlarges it, and no state depends on color alone. The snapshot, stale-feed state and role markers remain understandable when the connection stops. An independent screenshot review is required in addition to automated checks; a passing test suite does not establish visual quality.

## Factory character

The wall should feel like a software production floor:

- **Stations are visible.** Plan, build, review and landing are stable places in the layout; a job's current station is immediately clear.
- **Work-in-progress is concrete.** A job card names the item, worker, worktree, elapsed time and latest evidence instead of showing abstract activity counts.
- **Flow is legible.** The page shows work moving between stations and makes a stopped item interrupt that flow visually.
- **Handoffs are explicit.** The next station, the report it received and the reason work is waiting are visible without opening raw logs.
- **Quality is part of the surface.** Checks, review findings, setup state and fences sit beside progress rather than behind a separate admin page.
- **The page is calm.** Strong spacing, a small status palette and deliberate typography make the important exception visible without making the whole screen look urgent.
- **Roles have a visual code.** Agent roles may tint a rail and job marker: builder, fixer, reviewer and planner each have a stable visual role. The written role and a shape or icon carry the meaning too; the code does not identify a model or rely on color alone. The station remains a separate label.
- **Theme resolves meaning.** Semantic roles such as `builder`, `fixer`, `reviewer`, `planner`, `running`, `blocked` and `failed` are chosen by the layout and resolved by one fixed theme. Agent-role styling and job-state styling stay separate, so a role color never has to carry state as well.

## Job identity

Every visible active job carries the same compact identity block:

- **What.** Queue and item title, with the current action or latest lifecycle evidence.
- **Where.** Current station, worktree and branch.
- **Who.** Agent identity and delegation context when a job handed work to another agent.
- **State.** Running, waiting, blocked, fenced or finished, with elapsed time and the last update.
- **Next.** The next station or explicit reason the job cannot move.

These values come from persisted job claims, lifecycle events, reports and worker-environment records. The wall does not infer activity from a process name or a stale heartbeat.

## Scale

The wall remains an overview as the factory grows:

- **Summaries before lists.** Counts and station flow show the whole factory; only active, blocked, fenced and recently changed work appears on the first screen.
- **Attention is bounded.** The snapshot carries a bounded set of high-value rows and points to read-only queries for the rest, so more jobs do not make the page slower or louder.
- **Stations absorb volume.** A station shows its current work and backlog shape rather than expanding into one card per historical job.
- **Details open on demand.** A job, environment or event can be inspected separately without turning the wall into a table.
- **The transport stays quiet.** WebSocket updates send changed snapshots or bounded deltas, not an ever-growing event log.
- **The layout adapts.** The same hierarchy works as a fullscreen wall, a wide desktop page and a narrow browser window.

## Read-only boundary

The page may observe but never claim, retry, pause, resume, cancel, land, remove, push or alter a schedule. The server binds to `127.0.0.1`; its HTTP routes return snapshots and its WebSocket sends snapshots when they change. Client messages are rejected or ignored.

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

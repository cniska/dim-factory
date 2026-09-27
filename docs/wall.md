# The wall

A local, read-only page that shows where every factory order is. It is the one surface built for the owner; everything else in the factory is for agents.

```sh
dim wall          # serve it on loopback
dim wall --dev    # with hot reload
```

It always serves on the same port, so a link survives restarts; `DIM_WALL_PORT` picks another.

## The board

Three columns — **Queued**, **Running**, **Shipped** — answer where each order is. Those are the order's statuses.

- **Queued** holds orders never started, **Running** every started order that has not landed, **Shipped** the landed ones. A dropped order leaves the board.
- **A card** shows the title, the station, the worker and its role, and time since the last event. It does not repeat the status. An order waiting on approval is the orange card.
- **Bounded columns.** Each draws its most recent cards up to a fixed number, and its header carries the whole count.
- **The header** says whether the feed is live, stale or unavailable.

## The item view

Opening a card shows that order alone, as a dialog over the board:

- the order's identity and facts, on screen before the record loads
- the **Plan**, **Build** and **Review** artifacts, each a document the owner can read in place of the transcript and diff
- the history in order, from a station's start to its submitted artifact and the operator's approval

It reads the same record as `dim q order`, which also carries the order's evidence. The open dialog refreshes that order's record as new evidence arrives.
Artifact Markdown renders tables with equal-width columns and alternating row shading in a horizontally scrollable container. Inline code stays on one line; fenced code keeps its indentation and scrolls horizontally.

## Rules

- **Read-only.** The page never starts, ships, retries or changes anything. The server binds `127.0.0.1`, serves the snapshot (`/api/snapshot`), one order's record (`/api/order/<id>`) and a WebSocket of changed snapshots (`/ws`), and ignores anything a client sends. Controls wait until watching shows which decisions recur.
- **Human words on the page, ids in the record.** Titles and descriptions lead; ids and shas stay available for agents.
- **Shown, never inferred.** Every value comes from recorded attempts and events, not from a process name or a title.
- **Honest when down.** An unavailable database is stated, never rendered as rows.

## Look

Dark, calm and monospace (JetBrains Mono, no web font fetched). Grayscale surfaces with accents reserved for roles and states; color never carries meaning alone. No decorative motion. Works fullscreen across a room and in a narrow window.

## Code

[`src/wall/`](../src/wall/): `server.ts` serves the page and assembles the snapshot, `client.tsx` renders it.

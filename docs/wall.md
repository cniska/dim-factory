# The wall

A local, read-only page that shows where every factory order is. It is the one surface built for the owner; everything else in the factory is for agents.

```sh
dim wall          # serve it on loopback
dim wall --dev    # with hot reload
```

It always serves on the same port, so a link survives restarts; `DIM_WALL_PORT` picks another.

## The board

Three columns — **Queued**, **Running**, **Shipped** — answer where each order is. Those are the order's statuses.

- **Queued** holds orders never started, **Running** every started order that has not landed, **Shipped** the landed ones. A cancelled order leaves the board.
- **A card** shows the title, three lines of the description, the project, the station, the worker and its role, and time since the last event. A running order with no worker says so; a queued or shipped card has no worker or station line and stands shorter. It does not repeat the status. An order waiting on approval is the orange card.
- **Bounded columns.** Each draws its most recent cards up to a fixed number, and its header carries the whole count.
- **The header** says whether the feed is live, stale or unavailable.

## The item view

Opening a card shows that order alone, as a dialog over the board:

- the order's identity and facts, on screen before the record loads, showing the worker as a card does
- the **Plan**, **Build** and **Review** artifacts, each a document the owner can read in place of the transcript and diff
- the order's log in order, each entry its action, station, time and the worker that recorded it, or a faint "factory" for the factory's own entries, with no details

It reads the same record as `dim order show`, which also carries the order's evidence, and follows it as new entries arrive.
Artifact Markdown renders tables with equal-width columns and alternating row shading in a horizontally scrollable container. Inline code stays on one line; fenced code keeps its indentation and scrolls horizontally.

## Rules

- **Read-only.** The page never starts, ships, retries or changes anything. The server binds `127.0.0.1` and serves the page and two WebSockets: `/ws` pushes the board each time it changes, and `/ws?order=<id>` pushes one order. The page reads nothing else and never polls; the server ignores anything a client sends. It opens a WebSocket only for a request addressed to a loopback name and sent from its own page, so another site the owner visits, or a name rebound to this machine, reads nothing ([`src/wall/server.ts`](../src/wall/server.ts)). A worker's artifact renders its links as code and its images as their alt text ([`src/wall/markdown.tsx`](../src/wall/markdown.tsx)), so opening an order fetches nothing a worker named. Controls wait until watching shows which decisions recur.
- **Human words on the page, ids in the record.** Titles and descriptions lead; ids and shas stay available for agents.
- **Shown, never inferred.** Every value comes from recorded attempts and events, not from a process name or a title.
- **Honest when down.** An unreadable record is stated with its reason, and the board shows no cards. An unreadable order is stated with the server's reason, above any history already shown.

## Look

Dark, calm and monospace (JetBrains Mono, served from the wall's own port, so no web font is fetched). It never follows a system theme. Grayscale surfaces with accents reserved for roles and states; color never carries meaning alone. A card waiting on approval sits on its own ground, so a column reads as moving or not before its text does. Role colors are bright enough to tell from the body grey at card size and stay clear of the warning amber; the operator, who runs the line rather than working it, is white. No decorative motion. Works fullscreen across a room and in a narrow window. Text too long for its space ends in an ellipsis, never a spill or a wrap the layout did not plan.

import { CircleAlert, CircleCheck, CircleDot, CircleX, type LucideIcon, Radio } from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { age } from "./age";
import { Badge } from "./components/ui/badge";
import { Card, CardFooter, CardHeader } from "./components/ui/card";
import { Digits } from "./components/ui/digits";
import { Robot } from "./components/ui/robot";
import type { OrderStatus } from "./factory-order";
import type {
  WallItemChange,
  WallItemEntry,
  WallItemView,
  WallOrder,
  WallRole,
  WallSnapshot,
} from "./factory-wall";
import { cn } from "./lib/utils";
import { FAILURE_MARKS_SHOWN, ordersByStage, STATION_LABELS, WALL_COLUMNS } from "./wall-board";
import { ITEM_KIND_LABELS, RAIL_MARK_GLYPH, type RailStop, railStops, shortSha } from "./wall-item";
import "./wall.css";

const unavailableSnapshot: WallSnapshot = {
  generatedAt: "",
  source: "unavailable",
  orders: [],
  totals: { todo: 0, active: 0, done: 0 },
};

const statusLabels: Record<OrderStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  fenced: "Fenced",
  completed: "Completed",
  failed: "Failed",
};

const stopped = new Set<OrderStatus>(["blocked", "fenced", "failed"]);

const statusIcon: Record<OrderStatus, LucideIcon> = {
  working: CircleDot,
  waiting: CircleDot,
  blocked: CircleAlert,
  fenced: CircleAlert,
  completed: CircleCheck,
  failed: CircleAlert,
};

// Color carries the agent's role and nothing else; the station stays text, so the two
// never compete for the same signal. A tint that can be wrong about the one thing it carries
// is worse than a mark with none, so an unknown role takes no color.
const roleTint: Record<WallRole, string | undefined> = {
  planner: "text-role-planner",
  builder: "text-role-builder",
  reviewer: "text-role-reviewer",
  unknown: undefined,
};

const NO_WORKER = "no worker recorded";

function statusTint(status: OrderStatus): string {
  return stopped.has(status) ? "text-warn-foreground" : "text-muted-foreground";
}

// `hourCycle` rather than `hour12: false`, which reads midnight as 24 in some locales. The
// wall hangs on a screen in a room and shows one clock whoever is looking at it.
const clock = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

// Assembled from the parts rather than taking the locale's own separator, which differs
// across ICU builds, so the figure on the wall is ours and not the viewer's.
function timeLabel(updatedAt: string): string {
  const parts = clock.formatToParts(new Date(updatedAt));
  const part = (type: "hour" | "minute") => parts.find((p) => p.type === type)?.value ?? "00";
  return `${Number(part("hour"))}:${part("minute")}`;
}

/** The box every row of a card stands in, whatever it holds. One figure rather than a gap
 *  between rows sized off each one's type: a stack set that way steps unevenly down the card,
 *  and the rows stop sharing a rhythm the eye can follow across three columns. */
const ROW = "flex h-[18px] shrink-0 items-center gap-1.5 leading-none";

/** One mark per failed check, so three attempts read as three marks without a word. A cross
 *  rather than a tinted dot: the shape carries it where color is spent on roles, and the count
 *  stands in past what the card has room for. */
function FailedChecks({ count }: { count: number }) {
  const shown = Math.min(count, FAILURE_MARKS_SHOWN);

  return (
    <span
      role="img"
      className="flex items-center gap-1 text-danger"
      aria-label={`${count} ${count === 1 ? "failed check" : "failed checks"}`}
    >
      {Array.from({ length: shown }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the marks are identical, so a mark's position is the whole of its identity
        <CircleX key={index} size={12} strokeWidth={1.8} aria-hidden="true" />
      ))}
      {count > shown ? <span className="tabular-nums">+{count - shown}</span> : null}
    </span>
  );
}

function OrderCard({
  order,
  now,
  bumped,
  onOpen,
}: {
  order: WallOrder;
  now: Date;
  bumped: boolean;
  onOpen: (order: WallOrder) => void;
}) {
  const StatusIcon = statusIcon[order.status];

  return (
    <Card
      // The card is what a reader points at, so the whole of it opens the view. It stays an
      // article rather than becoming a button, because a button's children are read as its label
      // and the state, age, worker and station on the card would stop being read at all.
      onClick={() => onOpen(order)}
      stopped={stopped.has(order.status)}
      className={cn(
        "gap-0 p-2.5 text-left text-[11px] transition-colors duration-1000",
        "cursor-pointer hover:border-accent focus-visible:border-accent focus-visible:outline-none",
        // Lit on the beat this card changed and left to fade, so a glance a moment later
        // still shows which card moved.
        bumped && "border-accent duration-0",
      )}
    >
      <CardHeader className={cn(ROW, "justify-between text-quiet")}>
        <span className={cn("flex items-center gap-1.5", statusTint(order.status))}>
          {/* Where the column carries the state, the mark is what states it, so the mark is
              what has to name it to a reader who is not looking at the column. */}
          <StatusIcon
            size={12}
            strokeWidth={1.8}
            aria-hidden="true"
            className={order.status === "working" ? "breathing" : undefined}
          />
          {statusLabels[order.status]}
        </span>
        {/* Re-derived from the timestamp every second rather than read off the snapshot, so
            the board keeps moving between pushes instead of standing still. */}
        <span className="tabular-nums">
          <Digits value={age(order.lastEventAt, now)} />
        </span>
      </CardHeader>

      {/* The title is what the reader came for, so it wraps rather than being cut. Two rows of
          the card's own rhythm: enough for the titles the queue writes, and a bound a runaway
          title cannot grow the card past. */}
      <h3 className="line-clamp-2 min-h-[36px] shrink-0 font-medium text-foreground leading-[18px]">
        {order.title}
      </h3>

      {/* The row stands whether or not it holds anything, so a card does not change height the
          moment its first check fails and the column does not step as work arrives. */}
      <div className={ROW}>
        {order.status === "working" && order.failedChecks > 0 ? (
          <FailedChecks count={order.failedChecks} />
        ) : null}
      </div>

      {order.attention ? (
        <p role="status" className={cn(ROW, "truncate text-warn-foreground")}>
          {order.attention}
        </p>
      ) : null}

      <CardFooter className={cn(ROW, "mt-auto justify-between gap-1.5 text-quiet")}>
        {/* What opens the view from the keyboard, and what a screen reader is offered: the card
            around it stays readable as the article it is. */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(order);
          }}
          className="sr-only focus-visible:not-sr-only focus-visible:rounded-wall focus-visible:border focus-visible:px-1.5"
        >
          Open {order.title}
        </button>
        {/* Nobody recorded leaves the slot empty rather than spending the card's
            one identity line saying so: the absence is already the message. */}
        <span className="flex min-w-0 items-center gap-1.5">
          {order.worker ? (
            <>
              <Robot
                label={`${order.worker}, ${order.role === "unknown" ? "role unknown" : order.role}`}
                className={roleTint[order.role]}
              />
              <span className="truncate">{order.worker}</span>
            </>
          ) : null}
        </span>
        <Badge className="shrink-0">{STATION_LABELS[order.station]}</Badge>
      </CardFooter>
    </Card>
  );
}

function EntryEvidence({ entry }: { entry: WallItemEntry }) {
  if (entry.commit)
    return (
      <>
        {/* Shortened to what a person compares, with the whole sha on the element for an agent
            reading the page and for anyone who copies it. */}
        <code className="text-foreground" title={entry.commit.sha}>
          {shortSha(entry.commit.sha)}
        </code>
        {entry.commit.subject ? <span>{entry.commit.subject}</span> : null}
      </>
    );
  if (entry.check)
    return (
      <>
        <code className="text-foreground">{entry.check.command}</code>
        <span className={entry.check.exitCode === 0 ? undefined : "text-danger"}>
          exit {entry.check.exitCode}
        </span>
        {entry.check.result ? <span>{entry.check.result}</span> : null}
      </>
    );
  if (entry.finding)
    return (
      <>
        <Badge className="shrink-0">{entry.finding.dimension}</Badge>
        <span className={entry.finding.answer === "refused" ? "text-warn-foreground" : undefined}>
          {entry.finding.answer}
        </span>
        <span>{entry.finding.summary}</span>
        {/* The grounds are what a refusal rests on, so they carry the refusal's own color; the
            same field on a fixed finding is ordinary detail. */}
        {entry.finding.resolution ? (
          <span className={entry.finding.answer === "refused" ? "text-warn-foreground" : undefined}>
            {entry.finding.resolution}
          </span>
        ) : null}
      </>
    );
  if (entry.environment)
    return (
      <>
        <span>{entry.environment.phase}</span>
        <code className="text-foreground">{entry.environment.argv.join(" ")}</code>
        <span className={entry.environment.exitCode === 0 ? undefined : "text-danger"}>
          {entry.environment.signal ?? `exit ${entry.environment.exitCode ?? "unrecorded"}`}
        </span>
        {entry.environment.stdout ? <span>{entry.environment.stdout}</span> : null}
        {entry.environment.stderr ? <span className="text-danger">{entry.environment.stderr}</span> : null}
        {entry.environment.resources.map((resource) => (
          <code key={JSON.stringify(resource)}>{JSON.stringify(resource)}</code>
        ))}
      </>
    );
  if (entry.path) return <code className="text-foreground">{entry.path}</code>;
  if (entry.delegatedTo)
    return (
      <span>
        to {entry.delegatedTo.worker}
        {entry.delegatedTo.station ? ` at ${STATION_LABELS[entry.delegatedTo.station]}` : ""}
      </span>
    );
  return null;
}

/** What the order changed, beside its history rather than inside it: a file is not a moment in
 *  the story, and a builder that touches twenty of them would bury the events among them. A count
 *  nobody recorded is left blank, because zero lines changed is a different claim. */
function ItemChanges({ changes }: { changes: WallItemChange[] }) {
  return (
    <section className="flex w-[22rem] shrink-0 flex-col gap-2 border-l pl-5">
      <h3 className="text-foreground">Changes</h3>
      <ol className="flex flex-col gap-1">
        {changes.map((change) => (
          <li key={change.path} className="flex items-baseline justify-between gap-3 text-quiet">
            <code className="truncate text-muted-foreground" title={change.path}>
              {change.path}
            </code>
            <span className="shrink-0 tabular-nums">
              {change.added === undefined ? null : <span className="text-role-builder">+{change.added}</span>}
              {change.removed === undefined ? null : <span className="text-danger"> −{change.removed}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A worker as a moment names it, falling back to the worker the order is held by. Only the
 *  order's own worker takes its role's tint: a delegated agent's role is not recorded, so tinting
 *  it would state a role nothing holds. */
function EntryWorker({
  stop,
  order,
  held,
}: {
  stop: RailStop | undefined;
  order: WallOrder;
  /** The worker every unattributed moment belongs to, or nothing where the order delegated: a
   *  delegated moment records no actor either, and the holder would be the wrong name on it. */
  held: string | undefined;
}) {
  const marker = (worker: string) => (
    <>
      <Robot
        label={
          worker === order.worker && order.role !== "unknown"
            ? `${worker}, ${order.role}`
            : `${worker}, role unknown`
        }
        className={worker === order.worker ? roleTint[order.role] : roleTint.unknown}
      />
      <span className="truncate">{worker}</span>
    </>
  );

  const worker = stop?.worker ?? held;
  if (!worker && !stop?.handedTo) return <span />;

  return (
    <span className="flex items-center justify-end gap-1.5 whitespace-nowrap text-quiet">
      {marker(worker ?? NO_WORKER)}
      {stop?.handedTo ? (
        <>
          <span aria-hidden="true">{RAIL_MARK_GLYPH.handover}</span>
          {marker(stop.handedTo)}
        </>
      ) : null}
    </span>
  );
}

/** The rail and the history are one list in three columns rather than lists side by side: a
 *  history line that wraps takes its own rail stop with it, where separate lists drift apart at
 *  the first wrapped line and the rail stops indexing what it sits beside. The mark and the time
 *  lead because they order the page; who did it sits at the right edge, where a column of workers
 *  reads down the page on its own. */
function ItemHistory({ entries, order }: { entries: WallItemEntry[]; order: WallOrder }) {
  const stops = railStops(entries);
  // Only a claim, a start and a delegation record an actor, so every other moment of an
  // undelegated order belongs to the worker holding it. Once one was delegated, an unattributed
  // moment could be either agent's, and the holder's name on it would be the wrong one.
  const held = entries.some((entry) => entry.kind === "delegated") ? undefined : order.worker;

  return (
    <ol className="flex min-w-0 grow flex-col gap-2">
      {entries.map((entry, index) => {
        const stop = stops[index];

        return (
          <li
            // Two entries can share a kind and an instant, and their place in the written order is
            // what tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: position in the written order is the entry's identity
            key={`${entry.at}-${entry.kind}-${index}`}
            className="grid grid-cols-[minmax(5rem,auto)_1fr_auto] gap-x-5 border-b pb-2 last:border-b-0"
          >
            <span className="flex items-baseline gap-2 border-r pr-4 whitespace-nowrap text-quiet">
              <span aria-hidden="true" className="w-3 text-center text-foreground">
                {stop ? RAIL_MARK_GLYPH[stop.mark] : ""}
              </span>
              <span className="tabular-nums">{timeLabel(entry.at)}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="w-[9rem] shrink-0 text-foreground">{ITEM_KIND_LABELS[entry.kind]}</span>
              <EntryEvidence entry={entry} />
              {entry.reason ? <span>{entry.reason}</span> : null}
              {entry.fence ? <span className="text-warn-foreground">{entry.fence}</span> : null}
            </span>
            <EntryWorker stop={stop} order={order} held={held} />
          </li>
        );
      })}
    </ol>
  );
}

/** One order's own record, over the board. On the platform's `<dialog>`, which carries modality,
 *  focus and dismissal already — a component library would cost more than this surface. */
function ItemDialog({
  card,
  movedAt,
  onClose,
}: {
  /** The order as the board holds it, so the identity is on screen from the first frame rather
   *  than after the record arrives. */
  card: WallOrder;
  movedAt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const read = useItemView(card.id, movedAt);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
  }, []);

  const order = read.view?.order ?? card;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: dismissal from the keyboard is Escape, which the element carries itself
    <dialog
      ref={dialog}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, which is how one is told from a
      // click on anything inside it.
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      // The element takes focus when it opens, and the platform's focus ring on a whole dialog
      // is a blue frame around the surface rather than a mark on anything a reader can act on.
      className="m-auto max-h-[85vh] w-[min(64rem,92vw)] rounded-wall border bg-card p-0 text-[12px] text-muted-foreground outline-none backdrop:bg-black/70"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex flex-col gap-2 border-b p-5">
          <h2 className="text-[15px] text-foreground">{order.title}</h2>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-quiet">
            <div className="flex items-center gap-2">
              <dt>item</dt>
              <dd className="text-muted-foreground">{order.itemId}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>station</dt>
              <dd className="text-muted-foreground">{STATION_LABELS[order.station]}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>worker</dt>
              <dd className="flex items-center gap-1.5 text-muted-foreground">
                <Robot
                  label={`${order.worker ?? NO_WORKER}, ${order.role === "unknown" ? "role unknown" : order.role}`}
                  className={roleTint[order.role]}
                />
                {order.worker ?? NO_WORKER}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>status</dt>
              <dd className={stopped.has(order.status) ? "text-warn-foreground" : "text-muted-foreground"}>
                {statusLabels[order.status]}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>order</dt>
              <dd className="text-muted-foreground">{order.id}</dd>
            </div>
            {read.view?.branch ? (
              <div className="flex items-center gap-2">
                <dt>branch</dt>
                <dd className="text-muted-foreground">{read.view.branch}</dd>
              </div>
            ) : null}
            {read.view?.worktree ? (
              <div className="flex items-center gap-2">
                <dt>worktree</dt>
                <dd className="text-muted-foreground">{read.view.worktree}</dd>
              </div>
            ) : null}
          </dl>
        </header>

        {/* The dialog holds its size and its content scrolls, so the identity above stays with
            whatever is being read. */}
        <div className="flex min-h-0 gap-5 overflow-y-auto p-5">
          {read.view && read.view.entries.length > 0 ? (
            <>
              <ItemHistory entries={read.view.entries} order={order} />
              {read.view.changes.length > 0 ? <ItemChanges changes={read.view.changes} /> : null}
            </>
          ) : (
            <p className={read.state === "unavailable" ? "text-warn-foreground" : undefined}>
              {ITEM_READ_MESSAGE[read.state]}
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}

function BoardColumn({
  label,
  orders,
  total,
  now,
  bumped,
  onOpen,
}: {
  label: string;
  orders: WallOrder[];
  total: number;
  now: Date;
  bumped: ReadonlySet<string>;
  onOpen: (order: WallOrder) => void;
}) {
  const id = `column-${label.toLowerCase()}`;

  return (
    <section className="min-w-0" aria-labelledby={id}>
      <header className="mb-3 flex items-baseline justify-between border-b px-0.5 pb-2">
        <h2 id={id} className="text-sm tracking-tight">
          {label}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <Digits value={String(total)} />
        </span>
      </header>
      {/* An empty column says so by being empty; the count in its heading already reads 0. */}
      <div className="grid gap-1.5">
        {orders.map((order) => (
          <OrderCard order={order} key={order.id} now={now} bumped={bumped.has(order.id)} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

type FeedState = "live" | "stale" | "unavailable";

const FEED_ICON: Record<FeedState, LucideIcon> = {
  live: Radio,
  stale: CircleAlert,
  unavailable: CircleX,
};

const FEED_LABEL: Record<FeedState, string> = {
  live: "live feed",
  stale: "showing last snapshot",
  unavailable: "unavailable",
};

const FEED_TINT: Record<FeedState, string> = {
  live: "text-muted-foreground",
  stale: "text-warn-foreground",
  unavailable: "text-warn-foreground",
};

function feedStateOf(unavailable: boolean, stale: boolean): FeedState {
  if (unavailable) return "unavailable";
  if (stale) return "stale";
  return "live";
}

/** What a card would show, so a snapshot that changed nothing lights nothing. */
function cardState(order: WallOrder): string {
  return `${order.status}|${order.lastEventAt}|${order.failedChecks}|${order.worker ?? ""}|${order.attention ?? ""}`;
}

const BUMP_MS = 2000;

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<WallSnapshot>(unavailableSnapshot);
  const [stale, setStale] = useState(true);
  const [unavailable, setUnavailable] = useState(true);
  const [answered, setAnswered] = useState(false);
  const [lastMessage, setLastMessage] = useState<number | null>(null);
  const [bumped, setBumped] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef(new Map<string, string>());

  useEffect(() => {
    let socket: WebSocket | undefined;
    let clearBump: ReturnType<typeof setTimeout> | undefined;

    const accept = (data: WallSnapshot) => {
      // Marked on the beat a push changes something, then expired: the timer is cleared on
      // the way in, so a later push finding nothing new cannot leave the last one lit.
      const changed = new Set(
        data.orders
          .filter((order) => seen.current.get(order.id) !== cardState(order))
          .map((order) => order.id),
      );
      const first = seen.current.size === 0;
      seen.current = new Map(data.orders.map((order) => [order.id, cardState(order)]));
      clearTimeout(clearBump);
      // Everything is new on the first snapshot, and lighting the whole board says nothing.
      setBumped(first ? new Set() : changed);
      if (changed.size > 0 && !first) clearBump = setTimeout(() => setBumped(new Set()), BUMP_MS);

      setSnapshot(data);
      setStale(false);
      setUnavailable(false);
      setAnswered(true);
      setLastMessage(Date.now());
    };

    fetch("/api/snapshot")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then(accept)
      .catch(() => {
        setUnavailable(true);
        setAnswered(true);
      });
    try {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as WallSnapshot & { error?: string };
        if (data.error) {
          setStale(true);
          return;
        }
        accept(data);
      };
      socket.onclose = () => setStale(true);
      socket.onerror = () => setStale(true);
    } catch {
      setStale(true);
      setUnavailable(true);
      setAnswered(true);
    }
    return () => {
      clearTimeout(clearBump);
      socket?.close();
    };
  }, []);

  return { snapshot, stale, unavailable, answered, lastMessage, bumped };
}

type ItemRead = { state: "reading" | "read" | "unavailable"; view: WallItemView | null };

const ITEM_READ_MESSAGE: Record<ItemRead["state"], string> = {
  reading: "Reading the record.",
  read: "Nothing is recorded against this order yet.",
  unavailable: "This order's record could not be read.",
};

/** The open order's own record, read from the same tables `dim q order` reads. It is re-read on
 *  every beat the board reports for that order, so the view is as live as the board behind it. */
function useItemView(orderId: string, movedAt: string): ItemRead {
  const [read, setRead] = useState<ItemRead>({ state: "reading", view: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `movedAt` is why this re-reads — the beat the board reports for this order is the signal its record may have changed
  useEffect(() => {
    let current = true;
    fetch(`/api/order/${encodeURIComponent(orderId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: WallItemView) => {
        if (current) setRead({ state: "read", view: data });
      })
      .catch(() => {
        // A re-read that fails leaves the record already on screen where it is: the reader is
        // looking at it, and the last thing the server answered is still the last thing it said.
        if (current) setRead((last) => ({ state: "unavailable", view: last.view }));
      });
    return () => {
      current = false;
    };
  }, [orderId, movedAt]);

  return read;
}

/** A clock the board reads, so every age advances on the same beat. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  return now;
}

function App() {
  const { snapshot, stale, unavailable, answered, lastMessage, bumped } = useSnapshot();
  const now = useNow();
  const [opened, setOpened] = useState<WallOrder | null>(null);
  const feed = feedStateOf(unavailable, stale);
  const FeedIcon = FEED_ICON[feed];
  const columns = ordersByStage(snapshot.orders);
  // The board bounds what it draws, so the order a reader opened can leave the snapshot while the
  // view is open. Its own card is what the view keeps showing, and the snapshot's beat is what
  // goes on prompting a re-read.
  const onBoard = snapshot.orders.find((order) => order.id === opened?.id);
  const openCard = onBoard ?? opened;

  return (
    <main className="wall-shell mx-auto flex min-h-screen w-full max-w-[90rem] flex-col p-[clamp(1rem,2.6vw,2.4rem)]">
      <header className="flex items-end justify-between gap-6 pb-5">
        <h1 className="flex flex-col gap-0.5 leading-none">
          <span className="text-xs tracking-[0.18em] text-quiet">dim factory</span>
          <span className="text-[clamp(1.25rem,2vw,1.75rem)] tracking-tight">wall</span>
        </h1>
        <div
          className={cn(
            "flex h-9 items-center gap-2 rounded-wall border px-3 text-[11px] whitespace-nowrap",
            FEED_TINT[feed],
            // The box is held rather than the element dropped, so the header does not step
            // sideways when the first answer arrives.
            !answered && "invisible",
          )}
        >
          <FeedIcon size={15} aria-hidden="true" />
          <span>{FEED_LABEL[feed]}</span>
          {lastMessage ? (
            <span className="text-quiet">· {timeLabel(new Date(lastMessage).toISOString())}</span>
          ) : null}
        </div>
      </header>

      <section className="grid grid-cols-3 items-start gap-4 pb-16" aria-label="Factory kanban board">
        {WALL_COLUMNS.map(({ stage, label }) => (
          <BoardColumn
            key={stage}
            label={label}
            orders={columns[stage]}
            total={snapshot.totals[stage]}
            now={now}
            bumped={bumped}
            onOpen={setOpened}
          />
        ))}
      </section>

      {openCard ? (
        <ItemDialog
          // Keyed by order, so opening another card reads that record from nothing rather than
          // showing the last one until its read lands.
          key={openCard.id}
          card={openCard}
          movedAt={onBoard?.lastEventAt ?? snapshot.generatedAt}
          onClose={() => setOpened(null)}
        />
      ) : null}

      <footer className="mt-auto text-center text-[11px] tracking-[0.02em] text-quiet">
        Built with ♥︎ by{" "}
        <a
          className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-accent"
          href="https://crisu.me"
          target="_blank"
          rel="noopener noreferrer"
        >
          crisu.me
        </a>
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("wall page must provide a #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

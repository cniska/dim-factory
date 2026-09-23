import { CircleAlert, CircleCheck, CircleDot, CircleX, type LucideIcon, Radio, X } from "lucide-react";
import { Children, isValidElement, type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { age } from "./age";
import { Badge } from "./components/ui/badge";
import { Card, CardFooter, CardHeader } from "./components/ui/card";
import { Digits } from "./components/ui/digits";
import { Robot } from "./components/ui/robot";
import type {
  BoardStatus,
  WallItemEntry,
  WallItemView,
  WallOrder,
  WallRole,
  WallSnapshot,
} from "./factory-wall";
import { cn } from "./lib/utils";
import { msUntilNextMinute } from "./minute-beat";
import type { OrderLine } from "./order-line";
import { FAILURE_MARKS_SHOWN, ordersByStage, STATION_LABELS, WALL_COLUMNS } from "./wall-board";
import { ITEM_KIND_LABELS } from "./wall-item";
import "./wall.css";

const unavailableSnapshot: WallSnapshot = {
  generatedAt: "",
  source: "unavailable",
  orders: [],
  totals: { todo: 0, active: 0, done: 0 },
};

const statusLabels: Record<BoardStatus, string> = {
  queued: "Queued",
  working: "Working",
  completed: "Completed",
};

/** An order waiting on something off the floor, which is the one thing a card's own ground
 *  says. The status cannot carry it: a held order is still queued or working. */
function isStopped(order: { hold?: string }): boolean {
  return order.hold !== undefined;
}

const statusIcon: Record<BoardStatus, LucideIcon> = {
  queued: CircleDot,
  working: CircleDot,
  completed: CircleCheck,
};

// Color carries the agent's role and nothing else; the station stays text, so the two
// never compete for the same signal. A tint that can be wrong about the one thing it carries
// is worse than a mark with none, so an unknown role takes no color.
const roleTint: Record<WallRole, string | undefined> = {
  operator: "text-role-operator",
  planner: "text-role-planner",
  builder: "text-role-builder",
  reviewer: "text-role-reviewer",
};

const NO_WORKER = "none";

const LINE_LABELS: Record<OrderLine, string> = { feat: "feature", fix: "fix" };
const LINE_TINT: Record<OrderLine, string> = { feat: "bg-good", fix: "bg-danger" };

function statusTint(order: WallOrder): string {
  return isStopped(order) ? "text-warn-foreground" : "text-muted-foreground";
}

function LineMarker({ line, size = "card" }: { line: OrderLine; size?: "card" | "dialog" }) {
  return (
    <span
      role="img"
      aria-label={LINE_LABELS[line]}
      className={cn(
        "inline-block shrink-0 rounded-[1px]",
        size === "dialog" ? "h-[20px] w-[20px]" : "h-[12px] w-[12px]",
        LINE_TINT[line],
      )}
      title={LINE_LABELS[line]}
    />
  );
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
const ROW = "flex h-[18px] shrink-0 items-center gap-[var(--space-xs)] leading-none";

/** One mark per failed check, so three attempts read as three marks without a word. A cross
 *  rather than a tinted dot: the shape carries it where color is spent on roles, and the count
 *  stands in past what the card has room for. */
function FailedChecks({ count }: { count: number }) {
  const shown = Math.min(count, FAILURE_MARKS_SHOWN);

  return (
    <span
      role="img"
      className="flex items-center gap-[var(--space-sm)] text-danger"
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
      stopped={isStopped(order)}
      className={cn(
        "h-[164px] justify-between p-[var(--space-md)] text-left text-[11px]",
        "cursor-pointer hover:border-accent focus-visible:border-accent focus-visible:outline-none",
        // Lit until the bump expires, so a glance a moment after a card moved still shows
        // which one did.
        bumped && "border-accent",
      )}
    >
      <CardHeader className={cn(ROW, "justify-between text-quiet")}>
        <span className={cn("flex items-center gap-[var(--space-sm)]", statusTint(order))}>
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

      {/* The title keeps one row, so a long order cannot change the card's height or push its
          description and footer out of alignment with the cards beside it. */}
      <div className="flex min-w-0 items-center gap-[var(--space-sm)]">
        <LineMarker line={order.line} />
        <h3 className="min-w-0 truncate font-medium text-foreground leading-[18px]">{order.title}</h3>
      </div>

      <p className="line-clamp-3 min-h-[54px] shrink-0 text-quiet leading-[18px]">{order.description}</p>

      <CardFooter className={cn(ROW, "justify-between gap-[var(--space-sm)] text-quiet")}>
        {/* What opens the view from the keyboard, and what a screen reader is offered: the card
            around it stays readable as the article it is. */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(order);
          }}
          className="sr-only focus-visible:not-sr-only focus-visible:rounded-wall focus-visible:border focus-visible:px-[var(--space-xs)]"
        >
          Open {order.title}
        </button>
        {/* The worker slot keeps its shape when no hand has taken the order. */}
        <span className="flex min-w-0 items-center gap-[var(--space-xs)]">
          {order.status === "working" && order.failedChecks > 0 ? (
            <FailedChecks count={order.failedChecks} />
          ) : null}
          {order.worker && order.role ? (
            <WorkerLabel worker={order.worker} role={order.role} className="truncate" />
          ) : (
            <NoWorkerLabel />
          )}
        </span>
        {order.station === null ? null : <Badge className="shrink-0">{STATION_LABELS[order.station]}</Badge>}
      </CardFooter>
    </Card>
  );
}

function WorkerLabel({ worker, role, className }: { worker: string; role: WallRole; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-[var(--space-sm)]", className)}>
      <Robot label={`${worker}, ${role}`} className={roleTint[role]} />
      <span className="truncate">{worker}</span>
    </span>
  );
}

function NoWorkerLabel() {
  return (
    <span className="flex min-w-0 items-center gap-[var(--space-sm)] text-quiet">
      <Robot label="none" className="text-quiet opacity-60" />
      <span>{NO_WORKER}</span>
    </span>
  );
}

/** A worker as a moment names it, tinted for the role that worker holds rather than the one
 *  the order currently sits under: a history is a sequence of hands, and a reviewer's moment
 *  wearing the builder's color says the wrong thing about who wrote it. */
function EntryWorker({ entry }: { entry: WallItemEntry }) {
  if (!entry.worker || !entry.role) return <NoWorkerLabel />;

  return <WorkerLabel worker={entry.worker} role={entry.role} className="justify-end text-quiet" />;
}

function MarkdownLink({ children }: { children?: ReactNode }) {
  const parts = Children.toArray(children);
  const first = parts[0];

  if (parts.length === 1 && isValidElement(first) && first.type === "code") return first;
  return <code>{children}</code>;
}

/** An order's record as a table, because that is what it is: four columns whose widths are
 *  shared down the page, which a list of rows cannot do without pinning one to a fixed width.
 *  The time leads because it orders the page; who did it sits at the right edge, where a column
 *  of workers reads down on its own. */
const dayKey = new Intl.DateTimeFormat("en-CA");
const dayInYear = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
const dayWithYear = new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" });

function dayLabel(at: string, now: Date): string {
  const date = new Date(at);
  const days = (Date.parse(dayKey.format(now)) - Date.parse(dayKey.format(date))) / (24 * 60 * 60 * 1000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";

  return (dayKey.format(date).slice(0, 4) === dayKey.format(now).slice(0, 4) ? dayInYear : dayWithYear)
    .format(date)
    .toLowerCase();
}

function ItemHistory({ entries, now }: { entries: WallItemEntry[]; now: Date }) {
  const groups: Array<{ label: string; entries: WallItemEntry[] }> = [];

  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const group = groups.at(-1);
    if (!group || group.label !== label) groups.push({ label, entries: [entry] });
    else group.entries.push(entry);
  }

  return (
    <div className="min-w-0 space-y-[var(--space-lg)] text-[12px]">
      {groups.map((group) => (
        <section
          key={group.label}
          aria-labelledby={`timeline-${group.label}`}
          className="flex flex-col gap-[var(--space-lg)]"
        >
          <h3 id={`timeline-${group.label}`} className="text-[12px] leading-[18px] text-quiet">
            {group.label}
          </h3>
          <ol className="space-y-[var(--space-lg)]">
            {group.entries.map((entry, index) => {
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: entries can share every recorded field, so position is their identity
                  key={`${entry.at}-${entry.kind}-${index}`}
                >
                  <div className="flex min-h-[18px] flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-[var(--space-sm)] gap-y-[var(--space-xs)]">
                      <time dateTime={entry.at} className="text-quiet tabular-nums">
                        {timeLabel(entry.at)}
                      </time>
                      <strong className="font-normal text-foreground">{ITEM_KIND_LABELS[entry.kind]}</strong>
                    </div>
                    <EntryWorker entry={entry} />
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
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
  const StatusIcon = statusIcon[order.status];
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
        <header className="flex flex-col gap-[var(--space-lg)] border-b p-[var(--space-lg)]">
          <div className="flex items-start justify-between gap-[var(--space-md)]">
            <div className="flex min-w-0 items-center gap-[var(--space-md)]">
              <LineMarker line={order.line} size="dialog" />
              <h2 className="min-w-0 truncate text-lg font-medium text-foreground leading-7">
                {order.title}
              </h2>
            </div>
            {/* Escape and a backdrop click already close the dialog; neither is visible, so this
                is the one way out a reader does not have to already know. */}
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="shrink-0 cursor-pointer rounded-wall p-[var(--space-xs)] text-quiet transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
            >
              <X size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
          {order.description ? (
            <p className="whitespace-pre-wrap text-quiet leading-5">{order.description}</p>
          ) : null}
          <dl className="flex flex-wrap items-center gap-x-[var(--space-xl)] gap-y-[var(--space-xs)] text-quiet">
            <div className="flex items-center gap-[var(--space-sm)]">
              <dt>line</dt>
              <dd className="text-muted-foreground">{LINE_LABELS[order.line]}</dd>
            </div>
            <div className="flex items-center gap-[var(--space-sm)]">
              <dt>order</dt>
              <dd className="text-muted-foreground">{order.id}</dd>
            </div>
            <div className="flex items-center gap-[var(--space-sm)]">
              <dt>project</dt>
              <dd className="text-muted-foreground">{read.view?.project}</dd>
            </div>
            {order.station ? (
              <div className="flex items-center gap-[var(--space-sm)]">
                <dt>station</dt>
                <dd className="text-muted-foreground">{STATION_LABELS[order.station]}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-[var(--space-sm)]">
              <dt>assignee</dt>
              <dd className="flex items-center gap-[var(--space-xs)] text-muted-foreground">
                {order.worker && order.role ? (
                  <WorkerLabel worker={order.worker} role={order.role} />
                ) : (
                  <NoWorkerLabel />
                )}
              </dd>
            </div>
            <div className="flex items-center gap-[var(--space-sm)]">
              <dt>status</dt>
              <dd
                className={cn(
                  "flex items-center gap-[var(--space-sm)]",
                  isStopped(order) ? "text-warn-foreground" : "text-muted-foreground",
                )}
              >
                <StatusIcon
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  className={order.status === "working" ? "breathing" : undefined}
                />
                {statusLabels[order.status]}
              </dd>
            </div>
          </dl>
        </header>

        {/* The dialog holds its size and its content scrolls, so the identity above stays with
            whatever is being read. */}
        <div className="flex min-h-0 flex-col overflow-y-auto">
          {read.view?.plan ? (
            <section
              aria-labelledby="item-plan"
              className="min-w-0 space-y-[var(--space-lg)] px-[var(--space-lg)] pb-[var(--space-xxl)] pt-[var(--space-lg)]"
            >
              <div className="space-y-[var(--space-xs)]">
                <h3 id="item-plan" className="text-base font-medium text-foreground leading-6">
                  Plan
                </h3>
                <div className="flex flex-wrap items-center gap-x-[var(--space-sm)] gap-y-[var(--space-xs)] text-muted-foreground leading-5">
                  <WorkerLabel worker={read.view.plan.worker} role={read.view.plan.role} />
                  <span aria-hidden="true">·</span>
                  <span>revision {read.view.plan.revision}</span>
                  <span aria-hidden="true">·</span>
                  <span>{read.view.plan.approved ? "approved" : "awaiting approval"}</span>
                </div>
              </div>
              <div
                className={cn(
                  "space-y-[var(--space-sm)] text-quiet",
                  "[&_a]:text-quiet [&_a]:underline",
                  "[&_h1]:text-base [&_h1]:font-medium [&_h1]:text-foreground [&_h2]:text-sm [&_h2]:font-medium [&_h2]:text-foreground [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-foreground",
                  "[&_li]:my-[var(--space-xs)] [&_li]:leading-[18px] [&_ol]:my-[var(--space-sm)] [&_ol]:list-decimal [&_ol]:list-outside [&_ol]:marker:font-normal [&_ol]:marker:text-[12px] [&_ol]:marker:text-quiet [&_ol]:pl-[var(--space-lg)] [&_p]:leading-[18px] [&_pre]:overflow-x-auto [&_pre]:rounded-wall [&_pre]:border [&_pre]:p-[var(--space-sm)] [&_ul]:my-[var(--space-sm)] [&_ul]:list-[square] [&_ul]:list-outside [&_ul]:marker:font-normal [&_ul]:marker:text-[12px] [&_ul]:marker:text-quiet [&_ul]:pl-[var(--space-lg)]",
                )}
              >
                <Markdown components={{ a: MarkdownLink }}>{read.view.plan.body}</Markdown>
              </div>
            </section>
          ) : null}
          {read.view?.plan ? <div className="border-t" aria-hidden="true" /> : null}
          <section
            aria-labelledby="item-log"
            className="min-w-0 px-[var(--space-lg)] pb-[var(--space-lg)] pt-[var(--space-lg)]"
          >
            <h3
              id="item-log"
              className="mb-[var(--space-lg)] text-base font-medium text-foreground leading-6"
            >
              Log
            </h3>
            {read.view && read.view.entries.length > 0 ? (
              <ItemHistory entries={read.view.entries} now={new Date()} />
            ) : (
              <p className={read.state === "unavailable" ? "text-warn-foreground" : undefined}>
                {ITEM_READ_MESSAGE[read.state]}
              </p>
            )}
          </section>
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
      <header className="mb-[var(--space-sm)] flex items-baseline justify-between border-b px-0.5 pb-[var(--space-sm)]">
        <h2 id={id} className="text-lg tracking-tight">
          {label}
        </h2>
        <span className="text-lg text-quiet tabular-nums">
          <Digits value={String(total)} />
        </span>
      </header>
      {/* An empty column says so by being empty; the count in its heading already reads 0. */}
      <div className="grid gap-[var(--space-xs)]">
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
  return `${order.status}|${order.lastEventAt}|${order.failedChecks}|${order.worker ?? ""}`;
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

/**
 * A clock the board reads, so every age advances on the same beat.
 *
 * `freshAt` is the last answer the feed gave: a board left on a screen is a tab nobody has
 * touched, whose timers the browser throttles or stops outright, so a snapshot arriving after
 * that would otherwise be drawn against a clock as stale as the data it replaced.
 */
function useNow(freshAt: number | null): Date {
  const [now, setNow] = useState(() => new Date());
  const [read, setRead] = useState(freshAt);

  if (freshAt !== read) {
    setRead(freshAt);
    setNow(new Date());
  }

  useEffect(() => {
    let timer = 0;
    const beat = () => {
      setNow(new Date());
      timer = window.setTimeout(beat, msUntilNextMinute(Date.now()));
    };
    timer = window.setTimeout(beat, msUntilNextMinute(Date.now()));
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}

/**
 * A beat of its own, on the second, for the clock's separator alone.
 *
 * The clock reads this machine's time, so it goes on ticking whether or not anything is behind
 * it; the separator stopping is the wall's only sign that the feed did. It is kept off the
 * board's own beat, which counts in minutes and would redraw every card to blink one character.
 */
function useBlink(live: boolean): boolean {
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setOn((was) => !was), 1000);
    return () => clearInterval(tick);
  }, [live]);

  return live ? on : true;
}

/** The clock, its separator blinking while the feed is landing. */
function Clock({ at, beat }: { at: string; beat: boolean }) {
  // Read out of the string rather than assumed, so a clock with no separator is shown whole.
  const parts = /^(\d+)(\D)(\d+)$/.exec(at);
  if (!parts) return <span className="tabular-nums">{at}</span>;
  const [, hours = "", separator = "", minutes = ""] = parts;

  return (
    <span className="inline-flex tabular-nums">
      <Digits value={hours} />
      <span className={cn("transition-opacity duration-200", beat ? "opacity-100" : "opacity-25")}>
        {separator}
      </span>
      <Digits value={minutes} />
    </span>
  );
}

function App() {
  const { snapshot, stale, unavailable, answered, lastMessage, bumped } = useSnapshot();
  const now = useNow(lastMessage);
  const blink = useBlink(!stale && !unavailable);
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
      <header className="flex items-center justify-between gap-[var(--space-xl)] pb-[var(--space-lg)]">
        {/* The board is what the page is for, so its name sits at the weight of the feed
            state beside it rather than above the work as a title. */}
        <h1 className="flex h-9 items-center gap-[var(--space-sm)] text-[clamp(1.25rem,2vw,1.75rem)] tracking-tight whitespace-nowrap">
          <span className="text-quiet">dim-factory</span>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          <span>wall</span>
        </h1>
        <div
          className={cn(
            "flex items-center gap-[var(--space-sm)] rounded-wall border p-[var(--space-sm)] text-[11px] whitespace-nowrap",
            FEED_TINT[feed],
            // The box is held rather than the element dropped, so the header does not step
            // sideways when the first answer arrives.
            !answered && "invisible",
          )}
        >
          <FeedIcon size={15} aria-hidden="true" />
          <span>{FEED_LABEL[feed]}</span>
          <span className="flex items-baseline gap-[var(--space-xs)] text-quiet">
            <span aria-hidden="true">·</span>
            <Clock at={timeLabel(now.toISOString())} beat={blink} />
          </span>
        </div>
      </header>

      <section
        className="grid grid-cols-3 items-start gap-[var(--space-md)] pb-[var(--space-xxl)]"
        aria-label="Factory kanban board"
      >
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

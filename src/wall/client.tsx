import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Factory,
  type LucideIcon,
  Radio,
  X,
} from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { z } from "zod";
import { invariant, unreachable } from "../assert";
import type { Station, Status } from "../order-contract";
import type { Role } from "../worker-contract";
import { age } from "./age";
import { ordersByStatus, STATION_LABELS, WALL_COLUMNS } from "./board";
import { Badge } from "./components/ui/badge";
import { Card, CardFooter } from "./components/ui/card";
import { Digits } from "./components/ui/digits";
import { Robot } from "./components/ui/robot";
import { itemLabel } from "./item";
import { cn } from "./lib/utils";
import { WallMarkdown } from "./markdown";
import { msUntilNextMinute } from "./minute-beat";
import { formatCompactNumber } from "./number-format";
import {
  BoardPush,
  type BoardStatus,
  OrderPush,
  parsePush,
  type WallItemEntry,
  type WallItemView,
  type WallOrder,
  type WallSnapshot,
  type WallTokens,
  type WallWorker,
  type WallWorkerUsage,
} from "./wall-contract";
import "./styles.css";

const unavailableSnapshot: WallSnapshot = {
  orders: [],
  totals: { queued: 0, running: 0, shipped: 0 },
};

const statusLabels: Record<Status, string> = {
  queued: "Queued",
  running: "Running",
  shipped: "Shipped",
  cancelled: "Cancelled",
};

function isStopped(order: Pick<WallOrder, "next">): boolean {
  return order.next === "approve";
}

const STATION_VERBS: Record<Station, string> = {
  plan: "planned",
  build: "built",
  review: "reviewed",
};

const REWORK_VERBS: Record<Station, string> = {
  plan: "replanned",
  build: "rebuilt",
  review: "reviewed again",
};

const ARTIFACT_PROSE = cn(
  "wall-markdown flex flex-col gap-[var(--space-md)] text-quiet",
  "[&_a]:text-quiet [&_a]:underline",
  "[&_h1]:text-lg [&_h1]:font-medium [&_h1]:text-foreground [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-foreground [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-foreground",
  "[&_code]:font-mono [&_li+li]:mt-[var(--space-xs)] [&_li]:leading-[18px] [&_ol]:my-0 [&_ol]:list-decimal [&_ol]:list-outside [&_ol]:marker:font-normal [&_ol]:marker:text-[12px] [&_ol]:marker:text-quiet [&_ol]:pl-[var(--space-lg)] [&_p]:leading-[18px] [&_ul]:my-0 [&_ul]:list-[square] [&_ul]:list-outside [&_ul]:marker:font-normal [&_ul]:marker:text-[12px] [&_ul]:marker:text-quiet [&_ul]:pl-[var(--space-lg)]",
);

function Dot() {
  return (
    <span className="text-quiet" aria-hidden="true">
      ·
    </span>
  );
}

function ArtifactFacts({
  worker,
  revision,
  tokens,
  approved,
}: {
  worker: WallWorker | null;
  revision: number;
  tokens: WallTokens | null;
  approved: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-[var(--space-sm)] gap-y-[var(--space-xs)] text-muted-foreground leading-5">
      {worker ? <WorkerLabel worker={worker} /> : <NoWorkerLabel />}
      <Dot />
      <span>
        <span className="text-quiet">revision</span> <Digits value={String(revision)} />
      </span>
      {tokens && hasTokens(tokens) ? (
        <>
          <Dot />
          <TokensLabel tokens={tokens} />
        </>
      ) : null}
      {approved ? (
        <>
          <Dot />
          <span className="text-good">approved</span>
        </>
      ) : null}
    </div>
  );
}

function StationSection({ station, view }: { station: Station; view: WallItemView | null }) {
  const artifact = view?.[station] ?? null;
  const working = view?.working?.station === station ? view.working : null;
  const heading = `item-${station}`;
  return (
    <section
      aria-labelledby={heading}
      className="min-w-0 space-y-[var(--space-lg)] px-[var(--space-lg)] pb-[var(--space-lg)] pt-[var(--space-lg)]"
    >
      <div className="space-y-[var(--space-xs)]">
        <h3 id={heading} className="text-xl font-medium text-foreground leading-7">
          {STATION_LABELS[station]}
        </h3>
        {working ? (
          <ArtifactFacts
            worker={working.worker}
            revision={working.revision}
            tokens={working.worker?.tokens ?? null}
            approved={false}
          />
        ) : artifact ? (
          <ArtifactFacts
            worker={artifact.worker}
            revision={artifact.revision}
            tokens={artifact.tokens}
            approved={artifact.approved}
          />
        ) : null}
      </div>
      {working ? (
        <p aria-live="polite">
          <span className="shimmering">
            Order is being {(artifact ? REWORK_VERBS : STATION_VERBS)[station]}.
          </span>
        </p>
      ) : null}
      {artifact ? (
        <div className="space-y-[var(--space-lg)]">
          {working ? (
            <ArtifactFacts
              worker={artifact.worker}
              revision={artifact.revision}
              tokens={artifact.tokens}
              approved={artifact.approved}
            />
          ) : null}
          <div className={ARTIFACT_PROSE}>
            <WallMarkdown>{artifact.body}</WallMarkdown>
          </div>
        </div>
      ) : view && !working ? (
        <p className="text-quiet">Order has not been {STATION_VERBS[station]}.</p>
      ) : null}
    </section>
  );
}

function stateLabel(order: WallOrder): string {
  if (order.next === "approve") return "awaiting approval";
  return statusLabels[order.status];
}

const statusIcon: Record<Status, LucideIcon> = {
  queued: CircleDot,
  running: CircleDot,
  shipped: CircleCheck,
  cancelled: CircleX,
};

const roleTint: Record<Role, string | undefined> = {
  operator: "text-role-operator",
  planner: "text-role-planner",
  builder: "text-role-builder",
  reviewer: "text-role-reviewer",
};

const NO_WORKER = "none";

const clock = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

function timeLabel(updatedAt: string): string {
  const parts = clock.formatToParts(new Date(updatedAt));
  const part = (type: "hour" | "minute") => parts.find((p) => p.type === type)?.value ?? "00";
  return `${Number(part("hour"))}:${part("minute")}`;
}

const ROW = "flex h-[18px] shrink-0 items-center gap-[var(--space-xs)] leading-none";

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
  return (
    <Card
      onClick={() => onOpen(order)}
      stopped={isStopped(order)}
      className={cn(
        order.status === "running" ? "h-[172px]" : "h-[142px]",
        "justify-between p-[var(--space-md)] text-left text-[11px]",
        "cursor-pointer hover:border-accent has-[button:focus-visible]:border-accent",
        bumped && "border-accent",
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(order);
        }}
        className="sr-only"
      >
        Open {order.title}
      </button>
      <div className={cn(ROW, "justify-between gap-[var(--space-sm)]")}>
        <h3 className="min-w-0 truncate font-medium text-foreground leading-[18px]">{order.title}</h3>
        <span className="shrink-0 tabular-nums text-quiet">
          <Digits value={age(order.lastEventAt, now)} />
        </span>
      </div>

      <div className="flex min-h-[80px] shrink-0 flex-col gap-[var(--space-sm)] leading-[18px]">
        <p className="line-clamp-3 text-quiet">{order.description}</p>
        <p className="mt-auto truncate text-quiet/60">{order.project}</p>
      </div>

      {order.status === "running" ? (
        <CardFooter className={cn(ROW, "justify-between gap-[var(--space-sm)] text-quiet")}>
          <span className="flex min-w-0 items-center gap-[var(--space-xs)]">
            {order.worker ? <WorkerLabel worker={order.worker} className="truncate" /> : <NoWorkerLabel />}
          </span>
          {order.station === null ? null : <Badge>{STATION_LABELS[order.station]}</Badge>}
        </CardFooter>
      ) : null}
    </Card>
  );
}

const TOKEN_COLUMNS = ["Worker", "Calls", "In", "Out", "Cached"];

const CONTEXT_SHARES: readonly (keyof WallWorkerUsage["context"])[] = ["brief", "tools", "messages"];

function TokenCount({ value }: { value: number }) {
  return value === 0 ? (
    <span className="text-quiet">none</span>
  ) : (
    <Digits value={formatCompactNumber(value)} />
  );
}

const cachedPercent = (tokens: WallTokens) =>
  tokens.input === 0 ? 0 : Math.round((tokens.cachedRead / tokens.input) * 100);

function UsageCells({ usage }: { usage: WallWorkerUsage }) {
  return (
    <>
      <td className="text-quiet">
        <Digits value={String(usage.calls)} />
      </td>
      <td>
        <TokenCount value={usage.tokens.input} />
        {CONTEXT_SHARES.map((share) => (
          <span key={share} className="flex items-center text-quiet">
            {share}&nbsp;
            <TokenCount value={usage.context[share]} />
          </span>
        ))}
      </td>
      <td>
        <TokenCount value={usage.tokens.output} />
      </td>
      <td>
        <Digits value={`${cachedPercent(usage.tokens)}%`} />
      </td>
    </>
  );
}

function TokenSection({ view }: { view: WallItemView | null }) {
  return (
    <section
      aria-labelledby="item-tokens"
      className="min-w-0 space-y-[var(--space-lg)] px-[var(--space-lg)] pb-[var(--space-lg)] pt-[var(--space-lg)]"
    >
      <h3 id="item-tokens" className="text-xl font-medium text-foreground leading-7">
        Tokens
      </h3>
      {view === null ? null : view.usage.length === 0 ? (
        <p className="text-quiet">No station worker has run yet.</p>
      ) : (
        <div className="wall-markdown wall-table-scroll text-muted-foreground">
          <table className="!table-auto tabular-nums whitespace-nowrap">
            <thead>
              <tr>
                {TOKEN_COLUMNS.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.usage.map((usage) => (
                <tr key={usage.worker.name}>
                  <td>
                    <WorkerLabel worker={usage.worker} />
                    {usage.subagents === 0 ? null : (
                      <span className="flex items-center gap-[var(--space-sm)] text-quiet">
                        <Robot label="subagents" className="text-quiet opacity-60" />
                        <span>
                          <Digits value={String(usage.subagents)} />{" "}
                          {usage.subagents === 1 ? "subagent" : "subagents"}
                        </span>
                      </span>
                    )}
                  </td>
                  <UsageCells usage={usage} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TokensLabel({ tokens }: { tokens: WallTokens }) {
  const cached = cachedPercent(tokens);
  return (
    <span className="flex items-center gap-[var(--space-xs)] tabular-nums text-muted-foreground">
      <ArrowUp size={12} strokeWidth={1.8} aria-label="in" />
      <Digits value={formatCompactNumber(tokens.input)} />
      <ArrowDown size={12} strokeWidth={1.8} aria-label="out" className="ml-[var(--space-xs)]" />
      <Digits value={formatCompactNumber(tokens.output)} />
      <span className="text-quiet">
        (<Digits value={String(cached)} />% cached)
      </span>
    </span>
  );
}

const hasTokens = (tokens: WallTokens) => tokens.input + tokens.output > 0;

function WorkerLabel({ worker, className }: { worker: WallWorker; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-[var(--space-sm)] text-muted-foreground", className)}>
      <Robot label={`${worker.name}, ${worker.role}`} className={roleTint[worker.role]} />
      <span className="truncate">{worker.name}</span>
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

function FactoryLabel() {
  return (
    <span className="flex min-w-0 items-center justify-end gap-[var(--space-sm)] text-quiet">
      <Factory role="img" aria-label="factory" size={14} strokeWidth={2} className="shrink-0 opacity-60" />
      <span>factory</span>
    </span>
  );
}

function EntryActor({ entry }: { entry: WallItemEntry }) {
  return entry.worker === null ? (
    <FactoryLabel />
  ) : (
    <WorkerLabel worker={entry.worker} className="justify-end" />
  );
}

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
                  key={`${entry.at}-${entry.action}-${index}`}
                >
                  <div className="flex min-h-[18px] flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-[var(--space-sm)] gap-y-[var(--space-xs)]">
                      <time dateTime={entry.at} className="text-quiet tabular-nums">
                        {timeLabel(entry.at)}
                      </time>
                      <strong className="font-normal text-foreground">{itemLabel(entry)}</strong>
                    </div>
                    <EntryActor entry={entry} />
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

function ItemDialog({ card, onClose }: { card: WallOrder; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const read = useItemView(card.id);

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
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      className="m-auto max-h-[85vh] w-[min(64rem,92vw)] rounded-lg border bg-card p-0 text-[12px] text-muted-foreground outline-none backdrop:bg-black/70"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex flex-col gap-[var(--space-lg)] border-b p-[var(--space-lg)]">
          <div className="flex items-start justify-between gap-[var(--space-md)]">
            <h2 className="min-w-0 truncate text-lg font-medium text-foreground leading-7">{order.title}</h2>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="shrink-0 cursor-pointer rounded-wall p-[var(--space-xs)] text-quiet transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
            >
              <X size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
          <dl className="flex flex-wrap items-center gap-y-[var(--space-xs)] text-quiet [&>div+div]:before:mx-[var(--space-sm)] [&>div+div]:before:text-quiet/60 [&>div+div]:before:content-['·']">
            <div className="flex items-center">
              <dt className="sr-only">order</dt>
              <dd className="text-muted-foreground">{order.id}</dd>
            </div>
            <div className="flex min-w-0 max-w-full items-center">
              <dt className="sr-only">project</dt>
              <dd className="truncate text-muted-foreground">{order.project}</dd>
            </div>
            {order.station ? (
              <div className="flex items-center">
                <dt className="sr-only">station</dt>
                <dd className="text-muted-foreground lowercase">{STATION_LABELS[order.station]}</dd>
              </div>
            ) : null}
            {order.worker || order.status === "running" ? (
              <div className="flex min-w-0 max-w-full items-center">
                <dt className="sr-only">assignee</dt>
                <dd className="flex min-w-0 items-center gap-[var(--space-xs)] text-muted-foreground">
                  {order.worker ? <WorkerLabel worker={order.worker} /> : <NoWorkerLabel />}
                </dd>
              </div>
            ) : null}
            {read.view && hasTokens(read.view.tokens) ? (
              <div className="flex items-center">
                <dt className="sr-only">tokens</dt>
                <dd>
                  <TokensLabel tokens={read.view.tokens} />
                </dd>
              </div>
            ) : null}
            <div className="flex items-center">
              <dt className="sr-only">status</dt>
              <dd
                className={cn(
                  "flex items-center gap-[var(--space-sm)] lowercase",
                  isStopped(order) ? "text-warn-foreground" : "text-muted-foreground",
                )}
              >
                <StatusIcon size={12} strokeWidth={1.8} aria-hidden="true" />
                <span className={read.view?.working ? "shimmering" : undefined}>{stateLabel(order)}</span>
              </dd>
            </div>
          </dl>
        </header>

        <div className="flex min-h-0 flex-col overflow-y-auto">
          <p className="whitespace-pre-wrap px-[var(--space-lg)] pt-[var(--space-lg)] text-quiet leading-5">
            {order.description}
          </p>
          <StationSection station="plan" view={read.view} />
          <div className="border-t" aria-hidden="true" />
          <StationSection station="build" view={read.view} />
          <div className="border-t" aria-hidden="true" />
          <StationSection station="review" view={read.view} />
          <div className="border-t" aria-hidden="true" />
          <TokenSection view={read.view} />
          <div className="border-t" aria-hidden="true" />
          <section
            aria-labelledby="item-log"
            className="min-w-0 px-[var(--space-lg)] pb-[var(--space-lg)] pt-[var(--space-lg)]"
          >
            <h3 id="item-log" className="mb-[var(--space-lg)] text-xl font-medium text-foreground leading-7">
              Log
            </h3>
            <div className="space-y-[var(--space-lg)]">
              {read.state === "unavailable" ? (
                <p className="text-warn-foreground">{ITEM_READ_MESSAGE.unavailable}</p>
              ) : null}
              {read.view && read.view.entries.length > 0 ? (
                <ItemHistory entries={read.view.entries} now={new Date()} />
              ) : read.state === "unavailable" ? null : (
                <p>
                  <span className={read.state === "reading" ? "shimmering" : undefined}>
                    {ITEM_READ_MESSAGE[read.state]}
                  </span>
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </dialog>
  );
}

function BoardColumn({
  status,
  label,
  orders,
  total,
  now,
  bumped,
  onOpen,
}: {
  status: BoardStatus;
  label: string;
  orders: WallOrder[];
  total: number;
  now: Date;
  bumped: ReadonlySet<string>;
  onOpen: (order: WallOrder) => void;
}) {
  const id = `column-${status}`;

  return (
    <section className="min-w-0" aria-labelledby={id}>
      <header className="mb-[var(--space-md)] flex items-baseline justify-between border-b px-0.5 pb-[var(--space-sm)]">
        <h2 id={id} className="text-lg tracking-tight lowercase">
          {label}
        </h2>
        <span className="text-lg text-quiet tabular-nums">
          <Digits value={String(total)} />
        </span>
      </header>
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

function cardState(order: WallOrder): string {
  return `${order.status}|${order.lastEventAt}|${order.worker ?? ""}`;
}

const BUMP_MS = 2000;
const RECONNECT_MS = 1000;
const CLOCK_BLINK_MS = 1000;

type SocketState = "connecting" | "open" | "closed";

function useSocket<S extends z.ZodType>(
  path: string,
  schema: S,
  receive: (push: z.infer<S>) => void,
): SocketState {
  const [state, setState] = useState<SocketState>("connecting");
  const latest = useRef(receive);

  useEffect(() => {
    latest.current = receive;
  });

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const release = (current: WebSocket | undefined) => {
      if (current === undefined) return;
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      if (current.readyState !== WebSocket.CLOSED) current.close();
    };
    const connect = () => {
      clearTimeout(retry);
      release(socket);
      socket = undefined;
      if (stopped) return;
      const next = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`,
      );
      socket = next;
      next.onopen = () => {
        if (socket === next) setState("open");
      };
      next.onmessage = (event) => {
        if (socket !== next) return;
        const push = parsePush(schema, event.data);
        if (push !== null) latest.current(push);
      };
      next.onclose = () => {
        if (socket !== next) return;
        socket = undefined;
        setState("closed");
        if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      release(socket);
      socket = undefined;
    };
  }, [path, schema]);

  return state;
}

type Board = { snapshot: WallSnapshot; failed: boolean; readAt: number | null };

function useSnapshot() {
  const [board, setBoard] = useState<Board>({ snapshot: unavailableSnapshot, failed: false, readAt: null });
  const [bumped, setBumped] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef(new Map<string, string>());
  const clearBump = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(clearBump.current), []);

  const socket = useSocket("/ws", BoardPush, (push) => {
    switch (push.kind) {
      case "failure":
        setBoard({ snapshot: unavailableSnapshot, failed: true, readAt: Date.now() });
        return;
      case "snapshot": {
        const data = push.snapshot;
        const changed = new Set(
          data.orders
            .filter((order) => seen.current.get(order.id) !== cardState(order))
            .map((order) => order.id),
        );
        const first = seen.current.size === 0;
        seen.current = new Map(data.orders.map((order) => [order.id, cardState(order)]));
        clearTimeout(clearBump.current);
        setBumped(first ? new Set() : changed);
        if (changed.size > 0 && !first) clearBump.current = setTimeout(() => setBumped(new Set()), BUMP_MS);
        setBoard({ snapshot: data, failed: false, readAt: Date.now() });
        return;
      }
      default:
        unreachable(push);
    }
  });

  return {
    snapshot: board.snapshot,
    stale: socket !== "open",
    unavailable: board.failed || board.readAt === null,
    answered: board.readAt !== null || socket === "closed",
    lastMessage: board.readAt,
    bumped,
  };
}

type ItemRead = { state: "reading" | "read" | "unavailable"; view: WallItemView | null };

const ITEM_READ_MESSAGE: Record<ItemRead["state"], string> = {
  reading: "Reading the record.",
  read: "Nothing is recorded against this order yet.",
  unavailable: "This order's record could not be read.",
};

function useItemView(orderId: string): ItemRead {
  const [read, setRead] = useState<ItemRead>({ state: "reading", view: null });

  useSocket(`/ws?order=${encodeURIComponent(orderId)}`, OrderPush, (push) => {
    switch (push.kind) {
      case "order":
        setRead({ state: "read", view: push.view });
        return;
      case "failure":
        setRead((last) => ({ state: "unavailable", view: last.view }));
        return;
      default:
        unreachable(push);
    }
  });

  return read;
}

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

function useBlink(live: boolean): boolean {
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setOn((was) => !was), CLOCK_BLINK_MS);
    return () => clearInterval(tick);
  }, [live]);

  return live ? on : true;
}

function Clock({ at, beat }: { at: string; beat: boolean }) {
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
  const columns = ordersByStatus(snapshot.orders);
  const onBoard = snapshot.orders.find((order) => order.id === opened?.id);
  const openCard = onBoard ?? opened;

  return (
    <main className="wall-shell mx-auto flex min-h-screen w-full max-w-[90rem] flex-col p-[clamp(1rem,2.6vw,2.4rem)]">
      <header className="flex items-center justify-between gap-[var(--space-xl)] pb-[var(--space-lg)]">
        <h1 className="flex h-9 items-center gap-[var(--space-sm)] text-[clamp(1.25rem,2vw,1.75rem)] tracking-tight whitespace-nowrap">
          <span className="text-quiet">dim-factory</span>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          <span>wall</span>
        </h1>
        <div
          className={cn(
            "flex items-center gap-[var(--space-sm)] rounded-wall border px-[var(--space-md)] py-[var(--space-sm)] text-[11px] whitespace-nowrap",
            FEED_TINT[feed],
            !answered && "invisible",
          )}
        >
          <FeedIcon size={15} aria-hidden="true" />
          <span>{FEED_LABEL[feed]}</span>
          <span aria-hidden="true" className="text-quiet">
            ·
          </span>
          <Clock at={timeLabel(now.toISOString())} beat={blink} />
        </div>
      </header>

      <section
        className="grid grid-cols-3 items-start gap-[var(--space-md)] pb-[var(--space-xxl)]"
        aria-label="Factory kanban board"
      >
        {WALL_COLUMNS.map(({ status, label }) => (
          <BoardColumn
            key={status}
            status={status}
            label={label}
            orders={columns[status]}
            total={snapshot.totals[status]}
            now={now}
            bumped={bumped}
            onOpen={setOpened}
          />
        ))}
      </section>

      {openCard ? <ItemDialog key={openCard.id} card={openCard} onClose={() => setOpened(null)} /> : null}

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
invariant(root !== null, "the wall page provides a #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

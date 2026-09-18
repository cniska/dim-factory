import { CircleAlert, CircleCheck, CircleDot, CircleX, type LucideIcon, Radio } from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { age } from "./age";
import { Badge } from "./components/ui/badge";
import { Card, CardFooter, CardHeader } from "./components/ui/card";
import { Digits } from "./components/ui/digits";
import { Robot } from "./components/ui/robot";
import type { WallJob, WallRole, WallSnapshot, WallStatus } from "./factory-wall";
import { cn } from "./lib/utils";
import { jobsByLifecycle, STATION_LABELS, WALL_COLUMNS } from "./wall-board";
import "./wall.css";

const unavailableSnapshot: WallSnapshot = {
  generatedAt: "",
  source: "unavailable",
  jobs: [],
  totals: { todo: 0, active: 0, done: 0 },
};

const stateLabels: Record<WallStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  fenced: "Fenced",
  completed: "Completed",
  failed: "Failed",
  abandoned: "Abandoned",
};

const stopped = new Set<WallStatus>(["blocked", "fenced", "failed", "abandoned"]);

const statusIcon: Record<WallStatus, LucideIcon> = {
  running: CircleDot,
  waiting: CircleDot,
  blocked: CircleAlert,
  fenced: CircleAlert,
  completed: CircleCheck,
  failed: CircleAlert,
  abandoned: CircleX,
};

// Color carries the agent's role and nothing else; the station stays text, so the two
// never compete for the same signal.
const roleTint: Record<WallRole, string> = {
  planner: "text-role-planner",
  builder: "text-role-builder",
  reviewer: "text-role-reviewer",
  fixer: "text-role-fixer",
};

function statusTint(status: WallStatus): string {
  return stopped.has(status) ? "text-warn-foreground" : "text-muted-foreground";
}

function timeLabel(updatedAt: string): string {
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The box every row of a card stands in, whatever it holds. One figure rather than a gap
 *  between rows sized off each one's type: a stack set that way steps unevenly down the card,
 *  and the rows stop sharing a rhythm the eye can follow across three columns. */
const ROW = "flex h-[18px] shrink-0 items-center gap-1.5 leading-none";

function JobCard({ job, now, bumped }: { job: WallJob; now: Date; bumped: boolean }) {
  const StatusIcon = statusIcon[job.status];

  return (
    <Card
      stopped={stopped.has(job.status)}
      className={cn(
        "gap-0 p-2.5 text-[11px] transition-colors duration-1000",
        // Lit on the beat this card changed and left to fade, so a glance a moment later
        // still shows which card moved.
        bumped && "border-accent duration-0",
      )}
    >
      <CardHeader className={cn(ROW, "justify-between text-quiet")}>
        <span className={cn("flex items-center gap-1.5", statusTint(job.status))}>
          <StatusIcon
            size={12}
            strokeWidth={1.8}
            aria-hidden="true"
            className={job.status === "running" ? "breathing" : undefined}
          />
          {stateLabels[job.status]}
        </span>
        {/* Re-derived from the timestamp every second rather than read off the snapshot, so
            the board keeps moving between pushes instead of standing still. */}
        <span className="tabular-nums">
          <Digits value={age(job.updatedAt, now)} />
        </span>
      </CardHeader>

      <h3 className={cn(ROW, "truncate font-medium text-foreground")}>{job.item}</h3>

      <p className={cn(ROW, "truncate text-muted-foreground")}>{job.action}</p>

      {job.attention ? (
        <p role="status" className={cn(ROW, "truncate text-warn-foreground")}>
          {job.attention}
        </p>
      ) : null}

      <CardFooter className={cn(ROW, "mt-auto justify-between text-quiet")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Robot label={`${job.worker}, ${job.role}`} className={roleTint[job.role]} />
          <span className="truncate">{job.worker}</span>
        </span>
        <Badge className="shrink-0">{STATION_LABELS[job.station]}</Badge>
      </CardFooter>
    </Card>
  );
}

function BoardColumn({
  label,
  jobs,
  total,
  now,
  bumped,
}: {
  label: string;
  jobs: WallJob[];
  total: number;
  now: Date;
  bumped: ReadonlySet<string>;
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
        {jobs.map((job) => (
          <JobCard job={job} key={job.id} now={now} bumped={bumped.has(job.id)} />
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
function cardState(job: WallJob): string {
  return `${job.status}|${job.action}|${job.worker}|${job.attention ?? ""}`;
}

const BUMP_MS = 2000;

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<WallSnapshot>(unavailableSnapshot);
  const [stale, setStale] = useState(true);
  const [unavailable, setUnavailable] = useState(true);
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
        data.jobs.filter((job) => seen.current.get(job.id) !== cardState(job)).map((job) => job.id),
      );
      const first = seen.current.size === 0;
      seen.current = new Map(data.jobs.map((job) => [job.id, cardState(job)]));
      clearTimeout(clearBump);
      // Everything is new on the first snapshot, and lighting the whole board says nothing.
      setBumped(first ? new Set() : changed);
      if (changed.size > 0 && !first) clearBump = setTimeout(() => setBumped(new Set()), BUMP_MS);

      setSnapshot(data);
      setStale(false);
      setUnavailable(false);
      setLastMessage(Date.now());
    };

    fetch("/api/snapshot")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then(accept)
      .catch(() => setUnavailable(true));
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
    }
    return () => {
      clearTimeout(clearBump);
      socket?.close();
    };
  }, []);

  return { snapshot, stale, unavailable, lastMessage, bumped };
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
  const { snapshot, stale, unavailable, lastMessage, bumped } = useSnapshot();
  const now = useNow();
  const feed = feedStateOf(unavailable, stale);
  const FeedIcon = FEED_ICON[feed];
  const columns = jobsByLifecycle(snapshot.jobs);

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
          )}
        >
          <FeedIcon size={15} aria-hidden="true" />
          <span>{FEED_LABEL[feed]}</span>
          {lastMessage ? (
            <small className="text-quiet">· {timeLabel(new Date(lastMessage).toISOString())}</small>
          ) : null}
        </div>
      </header>

      <section className="grid grid-cols-3 items-start gap-4 pb-16" aria-label="Factory kanban board">
        {unavailable ? (
          <p className="col-span-full grid place-items-center rounded-wall border border-dashed p-4 text-center text-quiet">
            Waiting for a factory snapshot.
          </p>
        ) : (
          WALL_COLUMNS.map(({ lifecycle, label }) => (
            <BoardColumn
              key={lifecycle}
              label={label}
              jobs={columns[lifecycle]}
              total={snapshot.totals[lifecycle]}
              now={now}
              bumped={bumped}
            />
          ))
        )}
      </section>

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

import { CircleAlert, CircleCheck, CircleDot, CircleX, type LucideIcon, Radio } from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { age } from "./age";
import { Badge } from "./components/ui/badge";
import { Card, CardFooter, CardHeader } from "./components/ui/card";
import { Digits } from "./components/ui/digits";
import { Robot } from "./components/ui/robot";
import type {
  WallItemEntry,
  WallItemView,
  WallJob,
  WallRole,
  WallSnapshot,
  WallStatus,
} from "./factory-wall";
import { cn } from "./lib/utils";
import { FAILURE_MARKS_SHOWN, jobsByLifecycle, STATION_LABELS, WALL_COLUMNS } from "./wall-board";
import { ITEM_KIND_LABELS, RAIL_MARK_GLYPH, railStops, shortSha } from "./wall-item";
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

// What the column already asserts: Todo is where a job waits, Active is where a running one
// works, Done is where a completed one ends. Writing it again on every card in the column spends
// the card's quietest row saying what the heading said, and the mark keeps carrying it. What
// survives is what a column cannot say — the states that want a person.
const columnSaysTheState = new Set<WallStatus>(["waiting", "running", "completed"]);

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
// never compete for the same signal. A tint that can be wrong about the one thing it carries
// is worse than a mark with none, so an unknown role takes no color.
const roleTint: Record<WallRole, string | undefined> = {
  planner: "text-role-planner",
  builder: "text-role-builder",
  reviewer: "text-role-reviewer",
  unknown: undefined,
};

const NO_WORKER = "no worker recorded";

function statusTint(status: WallStatus): string {
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

function JobCard({
  job,
  now,
  bumped,
  onOpen,
}: {
  job: WallJob;
  now: Date;
  bumped: boolean;
  onOpen: (job: WallJob) => void;
}) {
  const StatusIcon = statusIcon[job.status];

  return (
    <Card
      // The card is what a reader points at, so the whole of it opens the view. It stays an
      // article rather than becoming a button, because a button's children are read as its label
      // and the state, age, worker and station on the card would stop being read at all.
      onClick={() => onOpen(job)}
      stopped={stopped.has(job.status)}
      className={cn(
        "gap-0 p-2.5 text-left text-[11px] transition-colors duration-1000",
        "cursor-pointer hover:border-accent focus-visible:border-accent focus-visible:outline-none",
        // Lit on the beat this card changed and left to fade, so a glance a moment later
        // still shows which card moved.
        bumped && "border-accent duration-0",
      )}
    >
      <CardHeader className={cn(ROW, "justify-between text-quiet")}>
        <span className={cn("flex items-center gap-1.5", statusTint(job.status))}>
          {/* Where the column carries the state, the mark is what states it, so the mark is
              what has to name it to a reader who is not looking at the column. */}
          <StatusIcon
            size={12}
            strokeWidth={1.8}
            {...(columnSaysTheState.has(job.status)
              ? { role: "img", "aria-label": stateLabels[job.status] }
              : { "aria-hidden": "true" })}
            className={job.status === "running" ? "breathing" : undefined}
          />
          {columnSaysTheState.has(job.status) ? null : stateLabels[job.status]}
        </span>
        {/* Re-derived from the timestamp every second rather than read off the snapshot, so
            the board keeps moving between pushes instead of standing still. */}
        <span className="tabular-nums">
          <Digits value={age(job.lastEventAt, now)} />
        </span>
      </CardHeader>

      {/* The title is what the reader came for, so it wraps rather than being cut. Two rows of
          the card's own rhythm: enough for the titles the queue writes, and a bound a runaway
          title cannot grow the card past. */}
      <h3 className="line-clamp-2 min-h-[36px] shrink-0 font-medium text-foreground leading-[18px]">
        {job.title}
      </h3>

      {/* The row stands whether or not it holds anything, so a card does not change height the
          moment its first check fails and the column does not step as work arrives. */}
      <div className={ROW}>
        {job.status === "running" && job.failedChecks > 0 ? <FailedChecks count={job.failedChecks} /> : null}
      </div>

      {job.attention ? (
        <p role="status" className={cn(ROW, "truncate text-warn-foreground")}>
          {job.attention}
        </p>
      ) : null}

      <CardFooter className={cn(ROW, "mt-auto justify-between gap-1.5 text-quiet")}>
        {/* What opens the view from the keyboard, and what a screen reader is offered: the card
            around it stays readable as the article it is. */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(job);
          }}
          className="sr-only focus-visible:not-sr-only focus-visible:rounded-wall focus-visible:border focus-visible:px-1.5"
        >
          Open {job.title}
        </button>
        {/* Nobody recorded leaves the slot empty rather than spending the card's
            one identity line saying so: the absence is already the message. */}
        <span className="flex min-w-0 items-center gap-1.5">
          {job.worker ? (
            <>
              <Robot
                label={`${job.worker}, ${job.role === "unknown" ? "role unknown" : job.role}`}
                className={roleTint[job.role]}
              />
              <span className="truncate">{job.worker}</span>
            </>
          ) : null}
        </span>
        <Badge className="shrink-0">{STATION_LABELS[job.station]}</Badge>
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

/** The rail and the history are one list in two columns rather than two lists side by side: a
 *  history line that wraps takes its own rail stop with it, where two lists drift apart at the
 *  first wrapped line and the rail stops indexing what it sits beside. */
function ItemHistory({ entries }: { entries: WallItemEntry[] }) {
  const stops = railStops(entries);

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
            className="grid grid-cols-[minmax(11rem,auto)_1fr] gap-x-5 border-b pb-2 last:border-b-0"
          >
            <span className="flex items-baseline gap-2 border-r pr-4 whitespace-nowrap text-quiet">
              <span aria-hidden="true" className="w-3 text-center text-foreground">
                {stop ? RAIL_MARK_GLYPH[stop.mark] : ""}
              </span>
              <span className="tabular-nums">{timeLabel(entry.at)}</span>
              <span className="truncate">
                {stop?.handedTo ? `${stop.worker ?? NO_WORKER} → ${stop.handedTo}` : (stop?.worker ?? "")}
              </span>
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="w-[9rem] shrink-0 text-foreground">{ITEM_KIND_LABELS[entry.kind]}</span>
              <EntryEvidence entry={entry} />
              {entry.reason ? <span>{entry.reason}</span> : null}
              {entry.fence ? <span className="text-warn-foreground">{entry.fence}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One job's own record, over the board. On the platform's `<dialog>`, which carries modality,
 *  focus and dismissal already — a component library would cost more than this surface. */
function ItemDialog({
  card,
  movedAt,
  onClose,
}: {
  /** The job as the board holds it, so the identity is on screen from the first frame rather
   *  than after the record arrives. */
  card: WallJob;
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

  const job = read.view?.job ?? card;

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
          <h2 className="text-[15px] text-foreground">{job.title}</h2>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-quiet">
            <div className="flex items-center gap-2">
              <dt>item</dt>
              <dd className="text-muted-foreground">{job.itemId}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>station</dt>
              <dd className="text-muted-foreground">{STATION_LABELS[job.station]}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>worker</dt>
              <dd className="flex items-center gap-1.5 text-muted-foreground">
                <Robot
                  label={`${job.worker ?? NO_WORKER}, ${job.role === "unknown" ? "role unknown" : job.role}`}
                  className={roleTint[job.role]}
                />
                {job.worker ?? NO_WORKER}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>state</dt>
              <dd className={stopped.has(job.status) ? "text-warn-foreground" : "text-muted-foreground"}>
                {stateLabels[job.status]}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt>job</dt>
              <dd className="text-muted-foreground">{job.id}</dd>
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
            <ItemHistory entries={read.view.entries} />
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
  jobs,
  total,
  now,
  bumped,
  onOpen,
}: {
  label: string;
  jobs: WallJob[];
  total: number;
  now: Date;
  bumped: ReadonlySet<string>;
  onOpen: (job: WallJob) => void;
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
          <JobCard job={job} key={job.id} now={now} bumped={bumped.has(job.id)} onOpen={onOpen} />
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
  return `${job.status}|${job.lastEventAt}|${job.failedChecks}|${job.worker ?? ""}|${job.attention ?? ""}`;
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
  read: "Nothing is recorded against this job yet.",
  unavailable: "This job's record could not be read.",
};

/** The open job's own record, read from the same tables `dim q job` reads. It is re-read on
 *  every beat the board reports for that job, so the view is as live as the board behind it. */
function useItemView(jobId: string, movedAt: string): ItemRead {
  const [read, setRead] = useState<ItemRead>({ state: "reading", view: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `movedAt` is why this re-reads — the beat the board reports for this job is the signal its record may have changed
  useEffect(() => {
    let current = true;
    fetch(`/api/job/${encodeURIComponent(jobId)}`)
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
  }, [jobId, movedAt]);

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
  const [opened, setOpened] = useState<WallJob | null>(null);
  const feed = feedStateOf(unavailable, stale);
  const FeedIcon = FEED_ICON[feed];
  const columns = jobsByLifecycle(snapshot.jobs);
  // The board bounds what it draws, so the job a reader opened can leave the snapshot while the
  // view is open. Its own card is what the view keeps showing, and the snapshot's beat is what
  // goes on prompting a re-read.
  const onBoard = snapshot.jobs.find((job) => job.id === opened?.id);
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
        {WALL_COLUMNS.map(({ lifecycle, label }) => (
          <BoardColumn
            key={lifecycle}
            label={label}
            jobs={columns[lifecycle]}
            total={snapshot.totals[lifecycle]}
            now={now}
            bumped={bumped}
            onOpen={setOpened}
          />
        ))}
      </section>

      {openCard ? (
        <ItemDialog
          // Keyed by job, so opening another card reads that record from nothing rather than
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

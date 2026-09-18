import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WallJob, WallRole, WallSnapshot, WallStatus } from "./factory-wall";
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
const roleGlyph: Record<WallRole, string> = { builder: "◆", fixer: "◇", reviewer: "▣", planner: "●" };
const stopped = new Set<WallStatus>(["blocked", "fenced", "failed", "abandoned"]);

function timeLabel(updatedAt: string): string {
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function JobCard({ job }: { job: WallJob }) {
  const warning = job.attention ? `Attention: ${job.attention}` : null;
  return (
    <article className={`job-card status-${job.status} role-${job.role}`}>
      <div className="job-top">
        <span className="state-mark"><span aria-hidden="true">{job.status === "running" ? "◉" : stopped.has(job.status) ? "!" : "○"}</span> {stateLabels[job.status]}</span>
        <span>{job.age}</span>
      </div>
      <h3>{job.item}</h3>
      <p className="action">{job.action}</p>
      <p className={`station-tag station-${job.station}`}>Station <strong>{STATION_LABELS[job.station]}</strong></p>
      <div className="job-meta">
        <span><span className="role-glyph" aria-hidden="true">{roleGlyph[job.role]}</span> {job.agent}</span>
        <span>Updated {timeLabel(job.updatedAt)}</span>
      </div>
      <div className="evidence"><span>Latest evidence</span><strong>{job.evidence}</strong></div>
      {warning ? <p className="card-warning" role="status">{warning}</p> : null}
    </article>
  );
}

function BoardColumn({ label, empty, jobs, total }: { label: string; empty: string; jobs: WallJob[]; total: number }) {
  const hidden = total - jobs.length;
  return (
    <section className="board-column" aria-labelledby={`column-${label.toLowerCase()}`}>
      <header className="column-heading">
        <h2 id={`column-${label.toLowerCase()}`}>{label}</h2>
        <span aria-label={`${total} items`}>{total}</span>
      </header>
      <div className="column-cards">
        {jobs.length ? jobs.map((job) => <JobCard job={job} key={job.id} />) : <p className="empty-column">{empty}</p>}
        {hidden > 0 ? <p className="column-overflow">{hidden} more not shown</p> : null}
      </div>
    </section>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<WallSnapshot>(unavailableSnapshot);
  const [stale, setStale] = useState(true);
  const [unavailable, setUnavailable] = useState(true);
  const [lastMessage, setLastMessage] = useState<number | null>(null);

  useEffect(() => {
    let socket: WebSocket | undefined;
    const accept = (data: WallSnapshot) => {
      setSnapshot(data);
      setStale(false);
      setUnavailable(false);
      setLastMessage(Date.now());
    };
    fetch("/api/snapshot")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(accept)
      .catch(() => setUnavailable(true));
    try {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as WallSnapshot & { error?: string };
        if (data.error) { setStale(true); return; }
        accept(data);
      };
      socket.onclose = () => setStale(true);
      socket.onerror = () => setStale(true);
    } catch { setStale(true); setUnavailable(true); }
    return () => socket?.close();
  }, []);

  const columns = jobsByLifecycle(snapshot.jobs);
  return (
    <main className="wall-shell">
      <header className="wall-header">
        <div><p className="eyebrow">DIM / FACTORY WALL</p><h1>Work in motion</h1><p className="lede">Read-only work moving through the factory.</p></div>
        <div className={`feed-status ${unavailable ? "unavailable" : stale ? "stale" : "live"}`}><span aria-hidden="true">{unavailable ? "!" : stale ? "◌" : "●"}</span><span>{unavailable ? "Unavailable" : stale ? "Showing last snapshot" : "Live feed"}</span>{lastMessage ? <small>· {timeLabel(new Date(lastMessage).toISOString())}</small> : null}</div>
      </header>
      {unavailable ? <aside className="stale-banner" role="status"><strong>Factory snapshot unavailable.</strong> Current work cannot be displayed until the data source responds.</aside> : stale ? <aside className="stale-banner" role="status"><strong>Showing the last known snapshot.</strong> The feed is not connected; card positions may be out of date.</aside> : null}
      <section className="board" aria-label="Factory kanban board">
        {unavailable ? <p className="board-unavailable">Waiting for a factory snapshot.</p> : WALL_COLUMNS.map(({ lifecycle, label, empty }) => <BoardColumn key={lifecycle} label={label} empty={empty} jobs={columns[lifecycle]} total={snapshot.totals[lifecycle]} />)}
      </section>
      <footer>Read-only · cards reflect the latest received snapshot</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

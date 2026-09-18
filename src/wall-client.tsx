import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bot, CircleAlert, CircleCheck, CircleDot, CircleX, Maximize2, Radio } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import type { WallJob, WallSnapshot, WallStatus } from "./factory-wall";
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

function timeLabel(updatedAt: string): string {
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function JobCard({ job }: { job: WallJob }) {
  const warning = job.attention ? `Attention: ${job.attention}` : null;
  const StatusIcon = job.status === "running" ? CircleDot : stopped.has(job.status) ? CircleAlert : job.status === "completed" ? CircleCheck : CircleX;
  return (
    <Card className={`job-card status-${job.status} role-${job.role}`}>
      <div className="job-top">
        <span className="state-mark"><StatusIcon size={14} strokeWidth={1.8} aria-hidden="true" /> {stateLabels[job.status]}</span>
        <span>{job.age}</span>
      </div>
      <h3>{job.item}</h3>
      <Badge className={`station-tag station-${job.station}`}>{STATION_LABELS[job.station]}</Badge>
      <div className="job-meta">
        <span className="worker"><Bot size={15} strokeWidth={1.7} aria-hidden="true" /> <span>{job.agent}</span></span>
        <span>Updated {timeLabel(job.updatedAt)}</span>
      </div>
      {warning ? <p className="card-warning" role="status">{warning}</p> : null}
    </Card>
  );
}

function BoardColumn({ label, jobs, total }: { label: string; jobs: WallJob[]; total: number }) {
  return (
    <section className="board-column" aria-labelledby={`column-${label.toLowerCase()}`}>
      <header className="column-heading">
        <h2 id={`column-${label.toLowerCase()}`}>{label}</h2>
        <span aria-label={`${total} items`}>{total}</span>
      </header>
      <div className="column-cards">
        {jobs.map((job) => <JobCard job={job} key={job.id} />)}
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
  const enterFullscreen = () => document.documentElement.requestFullscreen?.();
  return (
    <main className="wall-shell">
      <header className="wall-header">
        <div><p className="eyebrow">dim factory</p><h1><span>dim factory</span><span>wall</span></h1></div>
        <div className="wall-actions"><div className={`feed-status ${unavailable ? "unavailable" : stale ? "stale" : "live"}`}><span aria-hidden="true">{unavailable ? <CircleX size={15} /> : stale ? <CircleAlert size={15} /> : <Radio size={15} />}</span><span>{unavailable ? "unavailable" : stale ? "showing last snapshot" : "live feed"}</span>{lastMessage ? <small>· {timeLabel(new Date(lastMessage).toISOString())}</small> : null}</div><Button className="icon-button" type="button" onClick={enterFullscreen} aria-label="fullscreen"><Maximize2 size={16} aria-hidden="true" /></Button></div>
      </header>
      {unavailable ? <aside className="stale-banner" role="status"><strong>Factory snapshot unavailable.</strong> Current work cannot be displayed until the data source responds.</aside> : stale ? <aside className="stale-banner" role="status"><strong>Showing the last known snapshot.</strong> The feed is not connected; card positions may be out of date.</aside> : null}
      <section className="board" aria-label="Factory kanban board">
        {unavailable ? <p className="board-unavailable">Waiting for a factory snapshot.</p> : WALL_COLUMNS.map(({ lifecycle, label }) => <BoardColumn key={lifecycle} label={label} jobs={columns[lifecycle]} total={snapshot.totals[lifecycle]} />)}
      </section>
      <footer>read-only · cards reflect the latest received snapshot</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

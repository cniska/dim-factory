import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WallJob, WallRole, WallSnapshot, WallStation, WallStatus } from "./factory-wall";
import "./wall.css";

const unavailableSnapshot: WallSnapshot = {
  generatedAt: "",
  source: "unavailable",
  jobs: [],
  attention: [],
  next: ["Factory snapshot unavailable"],
  finished: [],
  activeTotal: 0,
  attentionTotal: 0,
  nextTotal: null,
  stationTotals: { plan: 0, build: 0, review: 0, landing: 0 },
};

const stateLabels: Record<WallStatus, string> = { running: "Running", waiting: "Waiting", blocked: "Blocked", fenced: "Fenced", completed: "Completed", failed: "Failed" };
const roleGlyph: Record<WallRole, string> = { builder: "◆", fixer: "◇", reviewer: "▣", planner: "●" };
const stationLabels: Record<WallStation, string> = { plan: "Plan", build: "Build", review: "Review", landing: "Landing" };

function ageLabel(updatedAt: string): string { return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function JobCard({ job }: { job: WallJob }) {
  return <article className={`job-card status-${job.status} role-${job.role}`}>
    <div className="job-top"><span className="station-pill">{stationLabels[job.station]}</span><span className="state-mark"><span aria-hidden="true">{job.status === "running" ? "◉" : job.status === "blocked" ? "!" : job.status === "fenced" ? "⊠" : "○"}</span> {stateLabels[job.status]}</span></div>
    <h3>{job.item}</h3>
    <p className="action">{job.action}</p>
    <dl className="identity"><div><dt>Who</dt><dd><span className="role-glyph" aria-hidden="true">{roleGlyph[job.role]}</span> {job.agent} · {job.role}</dd></div><div><dt>Where</dt><dd>{job.worktree} · {job.branch}</dd></div><div><dt>Age</dt><dd>{job.age} · updated {ageLabel(job.updatedAt)}</dd></div></dl>
    <div className="evidence"><span>Latest evidence</span><strong>{job.evidence}</strong></div>
    <div className="next"><span>Next</span><strong>{job.next}</strong></div>
  </article>;
}

function App() {
  const [snapshot, setSnapshot] = useState<WallSnapshot>(unavailableSnapshot);
  const [stale, setStale] = useState(true);
  const [unavailable, setUnavailable] = useState(true);
  const [lastMessage, setLastMessage] = useState<number | null>(null);
  useEffect(() => {
    let socket: WebSocket | undefined;
    fetch("/api/snapshot").then((response) => response.ok ? response.json() : Promise.reject()).then((data: WallSnapshot) => { setSnapshot(data); setStale(false); setUnavailable(false); setLastMessage(Date.now()); }).catch(() => { setUnavailable(true); });
    try {
      socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onmessage = (event) => { const data = JSON.parse(event.data) as WallSnapshot & { error?: string }; if (data.error) { setStale(true); return; } setSnapshot(data); setStale(false); setUnavailable(false); setLastMessage(Date.now()); };
      socket.onclose = () => setStale(true);
      socket.onerror = () => setStale(true);
    } catch { setStale(true); setUnavailable(true); }
    return () => socket?.close();
  }, []);
  const active = useMemo(() => snapshot.jobs, [snapshot]);
  return <main className="wall-shell">
    <header className="wall-header"><div><p className="eyebrow">DIM / FACTORY WALL</p><h1>Current work</h1><p className="lede">A read-only view of work moving through the factory.</p></div><div className={`feed-status ${unavailable ? "unavailable" : stale ? "stale" : "live"}`}><span aria-hidden="true">{unavailable ? "!" : stale ? "◌" : "●"}</span><span>{unavailable ? "Unavailable" : stale ? "Feed stale" : "Live feed"}</span>{lastMessage ? <small>· {new Date(lastMessage).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small> : null}</div></header>
    {unavailable ? <aside className="stale-banner" role="status"><strong>Factory snapshot unavailable.</strong> The wall is read-only and cannot display current state until its data source responds.</aside> : stale ? <aside className="stale-banner" role="status"><strong>Showing the last known snapshot.</strong> The feed is not connected; this wall cannot change factory state.</aside> : null}
    <section className="summary-grid" aria-label="Factory summary"><div><span>Active</span><strong>{snapshot.activeTotal}</strong></div><div><span>Attention</span><strong>{snapshot.attentionTotal}</strong></div><div><span>Next</span><strong>{snapshot.nextTotal === null ? "—" : snapshot.nextTotal}</strong></div><div><span>Source</span><strong>{snapshot.source}</strong></div></section>
    <section className="station-flow" aria-label="Factory stations">{(Object.keys(stationLabels) as WallStation[]).map((station) => <div className="station" key={station}><span>{stationLabels[station]}</span><strong>{snapshot.stationTotals[station]}</strong></div>)}</section>
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">NOW</p><h2>Active work</h2></div><span>{active.length ? `${active.length} of ${snapshot.activeTotal} visible` : "No active work recorded"}</span></div><div className="job-grid">{active.length ? active.map((job) => <JobCard job={job} key={job.id} />) : <p className="empty-state">No active work is available.</p>}</div></section>
    <div className="lower-grid"><section className="section-block"><div className="section-heading"><div><p className="eyebrow">ATTENTION</p><h2>Needs a decision</h2></div></div><ul className="plain-list">{snapshot.attention.length ? snapshot.attention.map((item) => <li key={item}><span aria-hidden="true">!</span>{item}</li>) : <li className="quiet">No attention items recorded.</li>}</ul></section><section className="section-block"><div className="section-heading"><div><p className="eyebrow">NEXT</p><h2>Eligible work</h2></div></div><ul className="plain-list">{snapshot.next.length ? snapshot.next.map((item) => <li key={item}><span aria-hidden="true">→</span>{item}</li>) : <li className="quiet">No eligible queue rows recorded.</li>}</ul></section></div>
    <section className="section-block finished"><div className="section-heading"><div><p className="eyebrow">RECENT</p><h2>Finished work</h2></div></div>{snapshot.finished.length ? <div className="finished-list">{snapshot.finished.map((job) => <div key={job.id}><span className="role-glyph" aria-hidden="true">{roleGlyph[job.role]}</span><strong>{job.item}</strong><span>{stateLabels[job.status]} · {job.evidence}</span></div>)}</div> : <p className="empty-state">No finished work is available.</p>}</section>
    <footer>Read-only · database snapshot {snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "unavailable"}</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WallJob, WallRole, WallSnapshot, WallStation, WallStatus } from "./factory-wall";
import "./wall.css";

const fixtureJobs: WallJob[] = [
  { id: "job-plan", item: "Define handoff contract", queue: "factory", station: "plan", worktree: "—", branch: "—", agent: "planner-01", role: "planner", status: "waiting", action: "Scope is ready for owner review", age: "8m", updatedAt: "2026-09-18T08:42:00Z", evidence: "docs/human-interface.md", next: "Build" },
  { id: "job-build", item: "Read-only factory wall", queue: "factory", station: "build", worktree: ".claude/worktrees/factory-wall", branch: "factory-wall", agent: "builder-01", role: "builder", status: "running", action: "Assembling the snapshot server", age: "14m", updatedAt: "2026-09-18T08:36:00Z", evidence: "bun run verify", next: "Review" },
  { id: "job-review", item: "Database handoff slice", queue: "factory", station: "review", worktree: ".claude/worktrees/handoff", branch: "factory-handoff", agent: "reviewer-01", role: "reviewer", status: "blocked", action: "Waiting for owner decision", age: "31m", updatedAt: "2026-09-18T08:19:00Z", evidence: "fence: scope unclear", next: "Owner attention", attention: "scope unclear" },
  { id: "job-fix", item: "Repair transcript cursor", queue: "factory", station: "build", worktree: ".claude/worktrees/cursor-fix", branch: "cursor-fix", agent: "fixer-01", role: "fixer", status: "fenced", action: "Stopped at a fence", age: "1h", updatedAt: "2026-09-18T07:50:00Z", evidence: "owner-judgment", next: "Owner attention", attention: "owner-judgment" },
];

const fixture: WallSnapshot = { generatedAt: "2026-09-18T08:56:00Z", source: "fixture", jobs: fixtureJobs, attention: ["Database handoff slice: scope unclear", "Repair transcript cursor: owner-judgment"], next: ["Read-only factory wall: Review", "Define handoff contract: Build"], finished: [{ id: "job-done", item: "Factory scheduler", queue: "factory", station: "landing", worktree: ".claude/worktrees/scheduler", branch: "factory-scheduler", agent: "builder-02", role: "builder", status: "completed", action: "Verified and landed", age: "2h", updatedAt: "2026-09-18T06:55:00Z", evidence: "6d89e7b", next: "Finished" }] };

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
  const [snapshot, setSnapshot] = useState<WallSnapshot>(fixture);
  const [stale, setStale] = useState(true);
  const [lastMessage, setLastMessage] = useState<number | null>(null);
  useEffect(() => {
    let socket: WebSocket | undefined;
    fetch("/api/snapshot").then((response) => response.ok ? response.json() : Promise.reject()).then((data: WallSnapshot) => { setSnapshot(data); setStale(false); setLastMessage(Date.now()); }).catch(() => undefined);
    try {
      socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onmessage = (event) => { const data = JSON.parse(event.data) as WallSnapshot; if (data.jobs) { setSnapshot(data); setStale(false); setLastMessage(Date.now()); } };
      socket.onclose = () => setStale(true);
      socket.onerror = () => setStale(true);
    } catch { setStale(true); }
    return () => socket?.close();
  }, []);
  const active = useMemo(() => snapshot.jobs.filter((job) => job.status !== "completed"), [snapshot]);
  return <main className="wall-shell">
    <header className="wall-header"><div><p className="eyebrow">DIM / FACTORY WALL</p><h1>Current work</h1><p className="lede">A read-only view of work moving through the factory.</p></div><div className={`feed-status ${stale ? "stale" : "live"}`}><span aria-hidden="true">{stale ? "◌" : "●"}</span><span>{stale ? "Feed stale" : "Live feed"}</span>{lastMessage ? <small>· {new Date(lastMessage).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small> : null}</div></header>
    {stale ? <aside className="stale-banner" role="status"><strong>Showing the last known snapshot.</strong> The feed is not connected; this wall cannot change factory state.</aside> : null}
    <section className="summary-grid" aria-label="Factory summary"><div><span>Active</span><strong>{active.length}</strong></div><div><span>Attention</span><strong>{snapshot.attention.length}</strong></div><div><span>Next</span><strong>{snapshot.next.length}</strong></div><div><span>Source</span><strong>{snapshot.source}</strong></div></section>
    <section className="station-flow" aria-label="Factory stations">{(Object.keys(stationLabels) as WallStation[]).map((station) => <div className="station" key={station}><span>{stationLabels[station]}</span><strong>{active.filter((job) => job.station === station).length}</strong></div>)}</section>
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">NOW</p><h2>Active work</h2></div><span>{active.length} visible</span></div><div className="job-grid">{active.map((job) => <JobCard job={job} key={job.id} />)}</div></section>
    <div className="lower-grid"><section className="section-block"><div className="section-heading"><div><p className="eyebrow">ATTENTION</p><h2>Needs a decision</h2></div></div><ul className="plain-list">{snapshot.attention.length ? snapshot.attention.map((item) => <li key={item}><span aria-hidden="true">!</span>{item}</li>) : <li className="quiet">No attention items recorded.</li>}</ul></section><section className="section-block"><div className="section-heading"><div><p className="eyebrow">NEXT</p><h2>Eligible work</h2></div></div><ul className="plain-list">{snapshot.next.length ? snapshot.next.map((item) => <li key={item}><span aria-hidden="true">→</span>{item}</li>) : <li className="quiet">No eligible queue rows recorded.</li>}</ul></section></div>
    <section className="section-block finished"><div className="section-heading"><div><p className="eyebrow">RECENT</p><h2>Finished work</h2></div></div><div className="finished-list">{snapshot.finished.map((job) => <div key={job.id}><span className="role-glyph" aria-hidden="true">{roleGlyph[job.role]}</span><strong>{job.item}</strong><span>{stateLabels[job.status]} · {job.evidence}</span></div>)}</div></section>
    <footer>Read-only · database snapshot {new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

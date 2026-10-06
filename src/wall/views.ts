import { invariant, unreachable } from "../assert";
import { roleAt } from "../order";
import type { LogEntry, OrderView, RunKind, Station } from "../order-contract";
import type {
  BoardOrder,
  BoardStatus,
  WallArtifact,
  WallItemEntry,
  WallItemView,
  WallOrder,
  WallSnapshot,
  WallTokens,
  WallWorker,
  WallWorking,
} from "./wall-contract";

export const MAX_COLUMN_CARDS = 12;

function workerNamed(view: OrderView, name: string): WallWorker {
  const worker = view.workers.find((candidate) => candidate.name === name);
  invariant(worker !== undefined, `order ${view.id} names worker ${name}`);
  return { name: worker.name, role: worker.role };
}

function stationWorker(view: OrderView, station: Station): WallWorker | null {
  const worker = view.workers.find((candidate) => candidate.role === roleAt(station));
  return worker === undefined ? null : { name: worker.name, role: worker.role };
}

export function cardOf(view: OrderView): WallOrder {
  const last = view.log.at(-1);
  invariant(last !== undefined, `order ${view.id} has a log`);
  const station = view.status === "running" ? view.station : null;
  return {
    id: view.id,
    title: view.title,
    project: view.project,
    description: view.description,
    station,
    worker: station === null ? null : stationWorker(view, station),
    status: view.status,
    lastEventAt: last.ts,
    next: view.status === "running" ? view.next : null,
  };
}

function onBoard(order: WallOrder): order is BoardOrder {
  return order.status !== "cancelled";
}

export function snapshotOf(views: readonly OrderView[]): WallSnapshot {
  const ranked = views
    .map(cardOf)
    .filter(onBoard)
    .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  const totals: Record<BoardStatus, number> = { queued: 0, running: 0, shipped: 0 };
  const orders: BoardOrder[] = [];
  for (const order of ranked) {
    totals[order.status] += 1;
    if (totals[order.status] <= MAX_COLUMN_CARDS) orders.push(order);
  }
  return { orders, totals };
}

function entryStation(entry: LogEntry): Station | null {
  switch (entry.action) {
    case "artifact_approved":
    case "artifact_returned":
    case "order_returned":
      return entry.details.station;
    case "plan_returned":
      return "plan";
    case "slice_submitted":
    case "slice_accepted":
    case "slice_refused":
    case "finding_answered":
    case "build_checked":
    case "build_refused":
    case "build_returned":
      return "build";
    case "review_returned":
      return "review";
    case "order_added":
    case "order_updated":
    case "order_run":
    case "workspace_created":
    case "order_cancelled":
    case "message_sent":
    case "message_refused":
    case "session_started":
    case "session_died":
    case "station_failed":
    case "ship_started":
    case "branch_rebased":
    case "ship_stopped":
    case "ship_landed":
      return null;
    default:
      return unreachable(entry);
  }
}

function entryOf(view: OrderView, entry: LogEntry): WallItemEntry {
  return {
    at: entry.ts,
    action: entry.action,
    station: entryStation(entry),
    worker: entry.by.kind === "worker" ? workerNamed(view, entry.by.worker) : null,
  };
}

type Returned = { readonly entry: LogEntry; readonly body: string };

export type TokensOf = (worker: string) => WallTokens;

function artifactOf(
  view: OrderView,
  station: Station,
  returns: readonly Returned[],
  tokensOf: TokensOf,
): WallArtifact | null {
  const last = returns.at(-1);
  if (last === undefined) return null;
  const { by, seq } = last.entry;
  invariant(by.kind === "worker", `order ${view.id}'s ${station} artifact was returned by a worker`);
  return {
    revision: returns.length,
    body: last.body,
    worker: workerNamed(view, by.worker),
    approved: view.log.some(
      (entry) => entry.action === "artifact_approved" && entry.details.station === station && entry.seq > seq,
    ),
    tokens: tokensOf(by.worker),
  };
}

function stationTokens(view: OrderView, tokensOf: TokensOf): WallTokens {
  return view.workers
    .filter((worker) => worker.role !== "operator")
    .map((worker) => tokensOf(worker.name))
    .reduce(
      (sum, tokens) => ({
        input: sum.input + tokens.input,
        output: sum.output + tokens.output,
        cachedRead: sum.cachedRead + tokens.cachedRead,
      }),
      { input: 0, output: 0, cachedRead: 0 },
    );
}

function artifactBody(entry: LogEntry, station: Station): string | null {
  switch (station) {
    case "plan":
      return entry.action === "plan_returned" ? entry.details.body : null;
    case "build":
      return entry.action === "build_returned" ? entry.details.artifact : null;
    case "review":
      return entry.action === "review_returned" && entry.details.returned.kind === "artifact"
        ? entry.details.returned.artifact.body
        : null;
    default:
      return unreachable(station);
  }
}

function returnsOf(log: readonly LogEntry[], station: Station): readonly Returned[] {
  return log.flatMap((entry): Returned[] => {
    const body = artifactBody(entry, station);
    return body === null ? [] : [{ entry, body }];
  });
}

function workingOf(view: OrderView, run: RunKind | null, tokensOf: TokensOf): WallWorking | null {
  if (run !== "station" || view.next !== "run") return null;
  const { station } = view;
  invariant(station !== null, `order ${view.id}'s station run is at a station`);
  const worker = stationWorker(view, station);
  return {
    station,
    worker: worker === null ? null : { ...worker, tokens: tokensOf(worker.name) },
    revision: returnsOf(view.log, station).length + 1,
  };
}

export function itemViewOf(view: OrderView, tokensOf: TokensOf, run: RunKind | null): WallItemView {
  return {
    order: cardOf(view),
    tokens: stationTokens(view, tokensOf),
    working: workingOf(view, run, tokensOf),
    plan: artifactOf(view, "plan", returnsOf(view.log, "plan"), tokensOf),
    build: artifactOf(view, "build", returnsOf(view.log, "build"), tokensOf),
    review: artifactOf(view, "review", returnsOf(view.log, "review"), tokensOf),
    entries: view.log.map((entry) => entryOf(view, entry)),
  };
}

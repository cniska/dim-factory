import type { WallJob, WallLifecycle, WallStation } from "./factory-wall";

export const WALL_COLUMNS: ReadonlyArray<{ lifecycle: WallLifecycle; label: string; empty: string }> = [
  { lifecycle: "todo", label: "Todo", empty: "No claimed work waiting to start" },
  { lifecycle: "active", label: "Active", empty: "Nothing in motion" },
  { lifecycle: "done", label: "Done", empty: "Nothing finished yet" },
];

export const STATION_LABELS: Record<WallStation, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
};

export function jobsByLifecycle(jobs: WallJob[]): Record<WallLifecycle, WallJob[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.lifecycle] = jobs.filter((job) => job.lifecycle === column.lifecycle);
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallLifecycle, WallJob[]>,
  );
}

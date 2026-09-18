import type { WallJob, WallLifecycle, WallStation } from "./factory-wall";

export const WALL_COLUMNS: ReadonlyArray<{ lifecycle: WallLifecycle; label: string }> = [
  { lifecycle: "todo", label: "Todo" },
  { lifecycle: "active", label: "Active" },
  { lifecycle: "done", label: "Done" },
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

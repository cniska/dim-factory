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
  unknown: "Unknown",
};

/** How many failure marks a card shows before the count stands in for them, so a job that
 *  failed its check twenty times cannot widen the card. */
export const FAILURE_MARKS_SHOWN = 6;

/** The snapshot arrives ranked — what needs a person first, then the rest by how recently
 *  something happened — so a column keeps the order it was handed. */
export function jobsByLifecycle(jobs: WallJob[]): Record<WallLifecycle, WallJob[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.lifecycle] = jobs.filter((job) => job.lifecycle === column.lifecycle);
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallLifecycle, WallJob[]>,
  );
}

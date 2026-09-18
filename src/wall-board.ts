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
  unknown: "Station unknown",
};

/** How many failure marks a card shows before the count stands in for them, so a job that
 *  failed its check twenty times cannot widen the card. */
export const FAILURE_MARKS_SHOWN = 6;

/** A job the owner has to answer sorts above one that is only running: a column read from the
 *  top then reads as what needs a person, then what is moving. Everything else keeps the
 *  snapshot's order, which is the most recently updated first. */
export function jobsByLifecycle(jobs: WallJob[]): Record<WallLifecycle, WallJob[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      const inColumn = jobs.filter((job) => job.lifecycle === column.lifecycle);
      columns[column.lifecycle] = [
        ...inColumn.filter((job) => job.attention),
        ...inColumn.filter((job) => !job.attention),
      ];
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallLifecycle, WallJob[]>,
  );
}

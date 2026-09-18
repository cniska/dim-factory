import type { WallJob, WallStation } from "./factory-wall";

export const WALL_COLUMNS: ReadonlyArray<{ station: WallStation; label: string }> = [
  { station: "plan", label: "Plan" },
  { station: "build", label: "Build" },
  { station: "review", label: "Review" },
  { station: "ship", label: "Ship" },
];

export function jobsByStation(jobs: WallJob[]): Record<WallStation, WallJob[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.station] = jobs.filter((job) => job.station === column.station);
      return columns;
    },
    { plan: [], build: [], review: [], ship: [] } as Record<WallStation, WallJob[]>,
  );
}

import type { WallOrder, WallStage, WallStation } from "./factory-wall";

export const WALL_COLUMNS: ReadonlyArray<{ stage: WallStage; label: string }> = [
  { stage: "todo", label: "Todo" },
  { stage: "active", label: "Active" },
  { stage: "done", label: "Done" },
];

export const STATION_LABELS: Record<WallStation, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
};

/** The snapshot arrives ranked — what needs a person first, then the rest by how recently
 *  something happened — so a column keeps the order it was handed. */
export function ordersByStage(orders: WallOrder[]): Record<WallStage, WallOrder[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.stage] = orders.filter((order) => order.stage === column.stage);
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallStage, WallOrder[]>,
  );
}

import type { WallOrder, WallStage } from "./factory-wall";
import type { Station } from "./station";

export const WALL_COLUMNS: ReadonlyArray<{ stage: WallStage; label: string }> = [
  { stage: "todo", label: "Todo" },
  { stage: "active", label: "Active" },
  { stage: "done", label: "Done" },
];

export const STATION_LABELS: Record<Station, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
};

export function ordersByStage(orders: WallOrder[]): Record<WallStage, WallOrder[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.stage] = orders.filter((order) => order.stage === column.stage);
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallStage, WallOrder[]>,
  );
}

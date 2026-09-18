import type { WallOrder, WallPhase, WallStation } from "./factory-wall";

export const WALL_COLUMNS: ReadonlyArray<{ phase: WallPhase; label: string }> = [
  { phase: "todo", label: "Todo" },
  { phase: "active", label: "Active" },
  { phase: "done", label: "Done" },
];

export const STATION_LABELS: Record<WallStation, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
  unknown: "Unknown",
};

/** How many failure marks a card shows before the count stands in for them, so an order that
 *  failed its check twenty times cannot widen the card. */
export const FAILURE_MARKS_SHOWN = 6;

/** The snapshot arrives ranked — what needs a person first, then the rest by how recently
 *  something happened — so a column keeps the order it was handed. */
export function ordersByPhase(orders: WallOrder[]): Record<WallPhase, WallOrder[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.phase] = orders.filter((order) => order.phase === column.phase);
      return columns;
    },
    { todo: [], active: [], done: [] } as Record<WallPhase, WallOrder[]>,
  );
}

import type { Station } from "../order-contract";
import type { BoardStatus, WallOrder } from "./wall-contract";

export const WALL_COLUMNS: ReadonlyArray<{ status: BoardStatus; label: string }> = [
  { status: "queued", label: "Queued" },
  { status: "running", label: "Running" },
  { status: "shipped", label: "Shipped" },
];

export const STATION_LABELS: Record<Station, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
};

export function ordersByStatus(orders: WallOrder[]): Record<BoardStatus, WallOrder[]> {
  return WALL_COLUMNS.reduce(
    (columns, column) => {
      columns[column.status] = orders.filter((order) => order.status === column.status);
      return columns;
    },
    { queued: [], running: [], shipped: [] } as Record<BoardStatus, WallOrder[]>,
  );
}

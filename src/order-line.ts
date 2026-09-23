export const ORDER_LINES = ["feat", "fix"] as const;

export type OrderLine = (typeof ORDER_LINES)[number];

export const ORDER_LINES_SQL = ORDER_LINES.map((line) => `'${line}'`).join(",");

export function isOrderLine(value: string): value is OrderLine {
  return (ORDER_LINES as readonly string[]).includes(value);
}

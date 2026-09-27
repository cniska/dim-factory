import type { OrderLine } from "./order-line";

export type BriefedOrder = { id: string; title: string; description: string | null; line: OrderLine };

export function lineBrief(line: OrderLine): string {
  return `This order's line is ${line}.`;
}

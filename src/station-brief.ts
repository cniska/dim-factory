import type { OrderLine } from "./order-line";

export type BriefedOrder = { id: string; title: string; description: string | null; line: OrderLine };

function lineBrief(line: OrderLine): string {
  return `This order's line is ${line}.`;
}

export function briefHeader(
  role: "planner" | "builder" | "reviewer",
  skill: "dim-plan" | "dim-build" | "dim-review",
  order: BriefedOrder,
  withLine = true,
): string[] {
  return [
    `You are the ${role} for factory order ${order.id} in this repository. Run ${skill}.`,
    "",
    `# ${order.title}`,
    ...(order.description ? [order.description] : []),
    ...(withLine ? ["", lineBrief(order.line)] : []),
  ];
}

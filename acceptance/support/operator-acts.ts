import type { DimResult, OperatorSession } from "./operator-session";
import type { OrderView } from "./order-view";

export type Decider = "owner" | "operator";

export async function addOrder(
  operator: OperatorSession,
  fields: { title?: string; request?: string; project?: string } = {},
): Promise<string> {
  const added = (await operator.dimOk([
    "order",
    "add",
    "--title",
    fields.title ?? "Greet the reader",
    "--request",
    fields.request ?? "Add a greeting to the README.",
    ...(fields.project ? ["--project", fields.project] : []),
  ])) as { id: string };
  return added.id;
}

export const runOrder = (operator: OperatorSession, id: string): Promise<DimResult> =>
  operator.dim(["order", "run", id]);

export const approve = (
  operator: OperatorSession,
  id: string,
  reason = "it does what the request asked",
  decided: Decider = "owner",
): Promise<DimResult> => operator.dim(["order", "approve", id, "--reason", reason, "--decided", decided]);

export const returnArtifact = (
  operator: OperatorSession,
  id: string,
  reason: string,
  decided: Decider = "owner",
): Promise<DimResult> => operator.dim(["order", "return", id, "--reason", reason, "--decided", decided]);

export const reviseOrder = (operator: OperatorSession, id: string, request: string): Promise<DimResult> =>
  operator.dim(["order", "revise", id, "--request", request]);

export const cancelOrder = (
  operator: OperatorSession,
  id: string,
  reason = "no longer wanted",
): Promise<DimResult> => operator.dim(["order", "cancel", id, "--reason", reason]);

export const messageWorker = (
  operator: OperatorSession,
  id: string,
  station: string,
  text: string,
): Promise<DimResult> => operator.dim(["message", "send", text, "--order", id, "--to", station]);

export async function showOrder(operator: OperatorSession, id: string): Promise<OrderView> {
  return (await operator.dimOk(["order", "show", id])) as OrderView;
}

export async function shipThrough(operator: OperatorSession, id: string): Promise<OrderView> {
  for (const station of ["plan", "build", "review"]) {
    const ran = station === "plan" ? await runOrder(operator, id) : await approve(operator, id);
    if (!ran.ok) throw new Error(`${station} did not finish: ${JSON.stringify(ran.error)}`);
  }
  const shipped = await approve(operator, id);
  if (!shipped.ok) throw new Error(`the Review approval did not ship: ${JSON.stringify(shipped.error)}`);
  return showOrder(operator, id);
}

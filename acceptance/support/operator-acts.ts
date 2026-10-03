import { z } from "zod";
import { ClaudeLine, type TranscriptEntry, transcriptEntries } from "./claude-transcript";
import { type DimResult, resultOf } from "./dim-output";
import type { OperatorSession } from "./operator-session";
import { OrderView } from "./order-view";
import type { Decider, Next, Station } from "./vocabulary";

type OrderFields = { readonly title?: string; readonly description?: string; readonly project?: string };

export async function addOrder(operator: OperatorSession, fields: OrderFields = {}): Promise<string> {
  const added = resultOf(
    await operator.dim(
      [
        "order",
        "add",
        "--title",
        fields.title ?? "Greet the reader",
        "--description",
        fields.description ?? "Add a greeting to the README.",
        ...(fields.project === undefined ? [] : ["--project", fields.project]),
      ],
      OrderView,
    ),
  );
  return added.id;
}

const runArgs = (id: string): readonly string[] => ["order", "run", id];

export const runOrder = (operator: OperatorSession, id: string): Promise<DimResult<OrderView>> =>
  operator.dim(runArgs(id), OrderView);

export const approveArgs = (
  id: string,
  reason = "it does what the order asked",
  decided: Decider = "owner",
): readonly string[] => ["order", "approve", id, "--reason", reason, "--decided", decided];

export const approve = (
  operator: OperatorSession,
  id: string,
  reason?: string,
  decided?: Decider,
): Promise<DimResult<OrderView>> => operator.dim(approveArgs(id, reason, decided), OrderView);

export const returnArtifact = (
  operator: OperatorSession,
  id: string,
  reason: string,
  decided: Decider = "owner",
): Promise<DimResult<OrderView>> =>
  operator.dim(["order", "return", id, "--reason", reason, "--decided", decided], OrderView);

export const updateOrder = (
  operator: OperatorSession,
  id: string,
  description: string,
): Promise<DimResult<OrderView>> =>
  operator.dim(["order", "update", id, "--description", description], OrderView);

export const cancelOrder = (
  operator: OperatorSession,
  id: string,
  reason = "no longer wanted",
): Promise<DimResult<OrderView>> => operator.dim(["order", "cancel", id, "--reason", reason], OrderView);

const Replied = z.strictObject({ reply: z.string() });

export const messageWorker = (
  operator: OperatorSession,
  id: string,
  station: Station,
  text: string,
): Promise<DimResult<z.infer<typeof Replied>>> =>
  operator.dim(["message", "send", text, "--order", id, "--to", station], Replied);

export async function showOrder(operator: OperatorSession, id: string): Promise<OrderView> {
  return resultOf(await operator.dim(["order", "show", id], OrderView));
}

const SessionShown = z.strictObject({ lines: z.array(ClaudeLine).readonly() });

export async function transcriptOf(
  operator: OperatorSession,
  session: string,
): Promise<readonly TranscriptEntry[]> {
  const shown = resultOf(await operator.dim(["session", "show", session], SessionShown));
  return transcriptEntries(shown.lines);
}

export const STEP_ARGS_BY_NEXT: Readonly<Record<Next, ((id: string) => readonly string[]) | null>> = {
  run: runArgs,
  approve: (id) => approveArgs(id),
  update: null,
};

export async function planned(operator: OperatorSession, fields: OrderFields = {}): Promise<string> {
  const id = await addOrder(operator, fields);
  resultOf(await runOrder(operator, id));
  return id;
}

export async function built(operator: OperatorSession, fields: OrderFields = {}): Promise<string> {
  const id = await planned(operator, fields);
  resultOf(await approve(operator, id));
  return id;
}

export async function reviewed(operator: OperatorSession, fields: OrderFields = {}): Promise<string> {
  const id = await built(operator, fields);
  resultOf(await approve(operator, id));
  return id;
}

export async function shipThrough(operator: OperatorSession, id: string): Promise<OrderView> {
  resultOf(await runOrder(operator, id));
  for (const artifact of ["plan", "Build artifact", "Review artifact"]) {
    resultOf(await approve(operator, id, `the ${artifact} does what the order asked`));
  }
  return showOrder(operator, id);
}

import { z } from "zod";
import { invariant } from "../assert";
import { RefusalRecord } from "../coded-error";
import { type Action, Detailed, Next, Station, Status } from "../order-contract";
import { ROLES } from "../worker-contract";

export const BoardStatus = Status.exclude(["cancelled"]);
export type BoardStatus = z.infer<typeof BoardStatus>;

export const WallWorker = z.object({ name: z.string(), role: z.enum(ROLES) });
export type WallWorker = z.infer<typeof WallWorker>;

export const WallOrder = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  description: z.string(),
  station: Station.nullable(),
  worker: WallWorker.nullable(),
  status: Status,
  lastEventAt: z.string(),
  next: Next.nullable(),
});
export type WallOrder = z.infer<typeof WallOrder>;

export const BoardOrder = WallOrder.extend({ status: BoardStatus });
export type BoardOrder = z.infer<typeof BoardOrder>;

export const WallSnapshot = z.object({
  orders: z.array(BoardOrder),
  totals: z.record(BoardStatus, z.number()),
});
export type WallSnapshot = z.infer<typeof WallSnapshot>;

function actionsOf(schema: z.core.$ZodType): string[] {
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(actionsOf);
  invariant(schema instanceof z.ZodObject, "an entry schema is an object or a union of them");
  const action = schema.shape.action;
  invariant(action instanceof z.ZodLiteral, "an entry schema names its action as a literal");
  return [String(action.value)];
}

const ACTIONS: ReadonlySet<string> = new Set(actionsOf(Detailed));

const isAction = (value: string): value is Action => ACTIONS.has(value);

export const WallItemEntry = z.object({
  at: z.string(),
  action: z.string().refine(isAction),
  station: Station.nullable(),
  worker: WallWorker.nullable(),
});
export type WallItemEntry = z.infer<typeof WallItemEntry>;

export const WallTokens = z.object({ input: z.number(), output: z.number(), cachedRead: z.number() });
export type WallTokens = z.infer<typeof WallTokens>;

export const WallArtifact = z.object({
  revision: z.number(),
  body: z.string(),
  worker: WallWorker,
  approved: z.boolean(),
  tokens: WallTokens,
});
export type WallArtifact = z.infer<typeof WallArtifact>;

export const WallWorking = z.object({
  station: Station,
  worker: WallWorker.extend({ tokens: WallTokens }).nullable(),
  revision: z.number(),
});
export type WallWorking = z.infer<typeof WallWorking>;

export const WallItemView = z.object({
  order: WallOrder,
  tokens: WallTokens,
  working: WallWorking.nullable(),
  plan: WallArtifact.nullable(),
  build: WallArtifact.nullable(),
  review: WallArtifact.nullable(),
  entries: z.array(WallItemEntry),
});
export type WallItemView = z.infer<typeof WallItemView>;

export const BoardPush = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: WallSnapshot }),
  z.object({ kind: z.literal("failure"), failure: RefusalRecord }),
]);
export type BoardPush = z.infer<typeof BoardPush>;

export const OrderPush = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), view: WallItemView }),
  z.object({ kind: z.literal("failure"), failure: RefusalRecord }),
]);
export type OrderPush = z.infer<typeof OrderPush>;

export function parsePush<S extends z.ZodType>(schema: S, text: string): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

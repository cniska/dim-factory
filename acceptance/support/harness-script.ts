import { z } from "zod";
import { WorkerAct } from "./worker-acts";

const HarnessAct = z.union([
  WorkerAct,
  z.discriminatedUnion("act", [
    z.strictObject({ act: z.literal("sh"), command: z.string() }),
    z.strictObject({ act: z.literal("write"), path: z.string(), content: z.string() }),
    z.strictObject({ act: z.literal("say"), text: z.string() }),
    z.strictObject({ act: z.literal("signal"), name: z.string() }),
    z.strictObject({ act: z.literal("wait"), name: z.string() }),
    z.strictObject({ act: z.literal("build-remaining"), artifact: z.string() }),
    z.strictObject({ act: z.literal("subagent"), agent: z.string(), command: z.string() }),
    z.strictObject({ act: z.literal("die") }),
    z.strictObject({ act: z.literal("limit"), resetsAt: z.string() }),
  ]),
]);

export type HarnessAct = z.infer<typeof HarnessAct>;

const HarnessTurn = z.array(HarnessAct).readonly();

export type HarnessTurn = z.infer<typeof HarnessTurn>;

const turns = z.array(HarnessTurn).readonly().optional();

export const HarnessScript = z.strictObject({ planner: turns, builder: turns, reviewer: turns });

export type HarnessScript = z.infer<typeof HarnessScript>;

export const ORDER_PLACEHOLDER = "{order}";

export const TMPDIR_PLACEHOLDER = "{tmpdir}";

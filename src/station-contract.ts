import { z } from "zod";
import { refuser } from "./coded-error";

const model = z.string().trim().min(1).optional();

export const Models = z.strictObject({ default: model, planner: model, builder: model, reviewer: model });
export type Models = z.infer<typeof Models>;

export const TurnRequest = z.object({ act: z.literal("plan_return"), plan: z.string() });
export type TurnRequest = z.infer<typeof TurnRequest>;

const Refusal = z.object({
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()),
  resolve: z.string(),
});

export const TurnReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: Refusal }),
]);
export type TurnReply = z.infer<typeof TurnReply>;

type StationRefusalMeta = {
  readonly no_turn: { readonly detail: string };
  readonly not_done: { readonly station: string; readonly missed: string };
  readonly harness_unset: { readonly project: string };
  readonly no_model: { readonly role: string; readonly file: string };
};

export const refuseStation = refuser<StationRefusalMeta>({
  no_turn: {
    message: ({ detail }) =>
      `this process runs in no open station turn, so it has no station to send work to: ${detail}`,
    resolve: () => "dim order show <order>",
  },
  not_done: {
    message: ({ station, missed }) => `the ${station} return is not done, so nothing was recorded: ${missed}`,
    resolve: () => "dim plan return <file>",
  },
  harness_unset: {
    message: ({ project }) =>
      `neither ${project}'s settings nor the user's name a harness to start its workers under`,
    resolve: () => "dim config set harness claude --project",
  },
  no_model: {
    message: ({ role, file }) =>
      `${file} names no model for the ${role} and no default, so no ${role} can start; it maps each role, or default, to a model`,
    resolve: () => "dim doctor",
  },
});

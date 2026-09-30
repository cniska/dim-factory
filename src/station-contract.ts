import { z } from "zod";
import { RefusalRecord, refuser } from "./coded-error";

export const PlanReturn = z.object({ act: z.literal("plan_return"), plan: z.string() });
export type PlanReturn = z.infer<typeof PlanReturn>;

export const OrderShow = z.object({ act: z.literal("order_show") });

export const TurnRequest = z.discriminatedUnion("act", [PlanReturn, OrderShow]);
export type TurnRequest = z.infer<typeof TurnRequest>;

export const TurnReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: RefusalRecord }),
]);
export type TurnReply = z.infer<typeof TurnReply>;

type StationRefusalMeta = {
  readonly no_turn: { readonly detail: string };
  readonly bad_request: { readonly issues: string };
  readonly not_done: { readonly station: string; readonly missed: string; readonly command: string };
  readonly no_return: { readonly order: string; readonly station: string; readonly session: string };
  readonly harness_unset: { readonly project: string };
  readonly no_model: { readonly role: string; readonly file: string };
};

export const refuseStation = refuser<StationRefusalMeta>({
  no_turn: {
    message: ({ detail }) =>
      `this process runs in no open station turn, so it has no station to send work to: ${detail}`,
    resolve: () => "dim order show <order>",
  },
  bad_request: {
    message: ({ issues }) => `the station could not read this request: ${issues}`,
    resolve: () => "dim doctor",
  },
  not_done: {
    message: ({ station, missed }) => `the ${station} return is not done, so nothing was recorded: ${missed}`,
    resolve: ({ command }) => command,
  },
  no_return: {
    message: ({ order, station, session }) =>
      `the ${station} worker's session ${session} ended with nothing returned, so order ${order} stays at ${station}`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  harness_unset: {
    message: ({ project }) =>
      `neither ${project}'s settings nor the user's name a harness to start its workers under`,
    resolve: () => "dim config set harness claude --project",
  },
  no_model: {
    message: ({ role, file }) =>
      `${file} names no model for the ${role} and no default, so no ${role} can start; its models setting maps each role, or default, to a model`,
    resolve: () => "dim config",
  },
});

import { z } from "zod";
import { RefusalRecord, refuser } from "./coded-error";
import { Answer, Finding } from "./order-contract";

export const PlanReturn = z.object({ act: z.literal("plan_return"), plan: z.string() });
export type PlanReturn = z.infer<typeof PlanReturn>;

export const OrderReturn = z.object({ act: z.literal("order_return"), reason: z.string() });
export type OrderReturn = z.infer<typeof OrderReturn>;

export const FindingAnswer = z.object({
  act: z.literal("finding_answer"),
  finding: z.string(),
  answer: Answer,
  reason: z.string(),
});
export type FindingAnswer = z.infer<typeof FindingAnswer>;

export const BuildReturn = z.object({ act: z.literal("build_return"), artifact: z.string() });
export type BuildReturn = z.infer<typeof BuildReturn>;

export const ReviewFindings = z.array(Finding).min(1);

export const ReviewReturn = z.object({
  act: z.literal("review_return"),
  returned: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("findings"), text: z.string() }),
    z.object({ kind: z.literal("artifact"), text: z.string() }),
  ]),
});
export type ReviewReturn = z.infer<typeof ReviewReturn>;

export const SliceSubmit = z.object({ act: z.literal("slice_submit") });

export const OrderShow = z.object({ act: z.literal("order_show") });

export const TurnRequest = z.discriminatedUnion("act", [
  PlanReturn,
  OrderReturn,
  FindingAnswer,
  BuildReturn,
  ReviewReturn,
  SliceSubmit,
  OrderShow,
]);
export type TurnRequest = z.infer<typeof TurnRequest>;

export const WORKER_COMMAND = {
  plan_return: "dim plan return <file>",
  order_return: "dim order return --reason <reason>",
  finding_answer: "dim finding answer <finding> fixed|refused --reason <reason>",
  build_return: "dim build return <file>",
  review_return: "dim review return --findings <file> | --artifact <file>",
  slice_submit: "dim slice submit",
  order_show: "dim order show",
} as const satisfies Record<TurnRequest["act"], string>;

export const TurnReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: RefusalRecord }),
]);
export type TurnReply = z.infer<typeof TurnReply>;

type StationRefusalMeta = {
  readonly no_turn: { readonly detail: string };
  readonly bad_request: { readonly issues: string };
  readonly no_reason: { readonly command: string };
  readonly wrong_station: { readonly act: string; readonly station: string };
  readonly no_finding: { readonly finding: string };
  readonly finding_answered: { readonly finding: string };
  readonly not_done: { readonly station: string; readonly missed: string; readonly command: string };
  readonly no_return: { readonly order: string; readonly station: string; readonly session: string };
  readonly return_missed: { readonly order: string; readonly station: string; readonly missed: string };
  readonly turn_stopped: { readonly order: string; readonly station: string };
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
  no_reason: {
    message: () => "a decision records why it was taken, and this one gives no reason",
    resolve: ({ command }) => command,
  },
  wrong_station: {
    message: ({ act, station }) => `${act} is no act of the ${station} station`,
    resolve: () => "dim order show",
  },
  no_finding: {
    message: ({ finding }) => `no open finding ${finding} was given to this build`,
    resolve: () => "dim order show",
  },
  finding_answered: {
    message: ({ finding }) => `finding ${finding} is answered already, and each finding is answered once`,
    resolve: () => "dim order show",
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
  return_missed: {
    message: ({ order, station, missed }) =>
      `the ${station} worker missed the definition of done twice, so the station failed and order ${order} stays at ${station}: ${missed}`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  turn_stopped: {
    message: ({ order, station }) => `order ${order}'s ${station} turn has failed and takes no more work`,
    resolve: ({ order }) => `dim order show ${order}`,
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

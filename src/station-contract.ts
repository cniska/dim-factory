import { z } from "zod";
import { RefusalRecord, refuser } from "./coded-error";
import { Answer, Finding, Reason, type Station } from "./order-contract";

export const PlanReturn = z.object({ act: z.literal("plan_return"), plan: z.string() });
export type PlanReturn = z.infer<typeof PlanReturn>;

export const OrderReturn = z.object({ act: z.literal("order_return"), reason: Reason });
export type OrderReturn = z.infer<typeof OrderReturn>;

export const FindingAnswer = z.object({
  act: z.literal("finding_answer"),
  finding: z.string(),
  answer: Answer,
  reason: Reason,
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

const SliceSubmit = z.object({ act: z.literal("slice_submit") });

const OrderShow = z.object({ act: z.literal("order_show") });

const MessageSend = z.object({
  act: z.literal("message_send"),
  text: z.string(),
  to: z.string().nullable(),
});

export const TurnRequest = z.discriminatedUnion("act", [
  PlanReturn,
  OrderReturn,
  FindingAnswer,
  BuildReturn,
  ReviewReturn,
  SliceSubmit,
  OrderShow,
  MessageSend,
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
  message_send: "dim message send <text>",
} as const satisfies Record<TurnRequest["act"], string>;

export const TurnReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: RefusalRecord }),
]);
export type TurnReply = z.infer<typeof TurnReply>;

type StationRefusalMeta = {
  readonly no_turn: { readonly detail: string };
  readonly bad_request: { readonly issues: string };
  readonly wrong_station: { readonly act: TurnRequest["act"]; readonly station: Station };
  readonly no_finding: { readonly finding: string };
  readonly finding_answered: { readonly finding: string };
  readonly not_done: { readonly station: Station; readonly missed: string; readonly command: string };
  readonly no_return: { readonly order: string; readonly station: Station; readonly session: string };
  readonly return_missed: { readonly order: string; readonly station: Station; readonly missed: string };
  readonly turn_stopped: { readonly order: string; readonly station: Station };
  readonly session_died: {
    readonly order: string;
    readonly station: Station;
    readonly session: string;
    readonly code: string;
  };
  readonly git_config_changed: { readonly order: string; readonly station: Station; readonly config: string };
  readonly no_model: { readonly role: string; readonly file: string };
  readonly not_to_operator: { readonly to: string };
  readonly message_turn: { readonly act: TurnRequest["act"] };
  readonly no_reply: { readonly order: string; readonly station: Station; readonly session: string };
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
  session_died: {
    message: ({ order, station, session, code }) =>
      `the ${station} worker's session ${session} died (${code}) before it returned, so order ${order} stays at ${station}; the next run carries on in a new session holding what it held`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  git_config_changed: {
    message: ({ order, station, config }) =>
      `the ${station} worker changed ${config}, which git runs as the owner, so the file was put back, the station failed and order ${order} stays at ${station}`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  no_model: {
    message: ({ role, file }) =>
      `${file} names no model for the ${role} and no default, so no ${role} can start; its models setting maps each role, or default, to a model`,
    resolve: () => "dim config",
  },
  not_to_operator: {
    message: ({ to }) =>
      `a station worker's message goes only to the operator, so this one to ${to} was recorded as refused and not delivered`,
    resolve: () => "dim message send <text>",
  },
  message_turn: {
    message: ({ act }) =>
      `${act} is no act of a message turn, which only reads; the reply is this turn's final text`,
    resolve: () => "dim order show",
  },
  no_reply: {
    message: ({ order, station, session }) =>
      `the ${station} worker's session ${session} ended its message turn on order ${order} with an error and no reply`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
});

import { z } from "zod";
import type { ActKind, Later, Station } from "./order-contract";
import type { TurnRequest } from "./station-contract";
import type { Rebased } from "./workspace";

export const TraceLine = z.looseObject({ order: z.string() });

type LineKey = "at" | "pid" | "order" | "seq" | "step" | "phase" | "ms" | "outcome";

type Fields<T> = Extract<keyof T, LineKey> extends never ? T : never;

type Step<Start, Result = Readonly<Record<never, never>>> = {
  readonly start: Fields<Start>;
  readonly result: Fields<Result>;
};

export type Steps = {
  readonly run: Step<{ readonly act: ActKind; readonly station: Station | null }>;
  readonly run_start: Step<{ readonly act: ActKind }, { readonly cause: number }>;
  readonly record: Step<{ readonly action: Later["action"] }, { readonly entry: number }>;
  readonly act: Step<{ readonly act: TurnRequest["act"] }>;
  readonly worktree_add: Step<{ readonly dir: string; readonly base: string }>;
  readonly worktree_remove: Step<{ readonly dir: string }, { readonly kept: boolean }>;
  readonly branch_delete: Step<{ readonly branch: string }, { readonly kept: boolean }>;
  readonly branch_move: Step<{ readonly repo: string; readonly branch: string; readonly to: string }>;
  readonly workspace_reset: Step<{ readonly dir: string; readonly head: string }>;
  readonly workspace_restore: Step<{ readonly dir: string; readonly head: string }>;
  readonly rebase_abort: Step<{ readonly dir: string }>;
  readonly rebase: Step<
    { readonly dir: string; readonly onto: string },
    { readonly result: Rebased["kind"] }
  >;
  readonly land: Step<{ readonly repo: string; readonly head: string }, { readonly landed: boolean }>;
  readonly check: Step<
    { readonly tree: string; readonly command: string },
    { readonly exitCode: number | null }
  >;
  readonly install: Step<
    { readonly tree: string; readonly command: string },
    { readonly exitCode: number | null }
  >;
  readonly toolchain: Step<{ readonly checkout: string }, { readonly bins: readonly string[] }>;
  readonly lock: Step<{ readonly path: string }>;
  readonly turn_open: Step<{ readonly home: string }, { readonly dir: string }>;
  readonly turn_close: Step<{ readonly dir: string }>;
  readonly harness_spawn: Step<
    { readonly cwd: string; readonly session: string },
    { readonly harness: number }
  >;
  readonly harness_wait: Step<{ readonly harness: number }, { readonly exitCode: number | null }>;
  readonly harness_kill: Step<{ readonly harness: number }>;
  readonly session_copy: Step<{ readonly session: string }>;
  readonly session_restore: Step<{ readonly session: string }>;
  readonly config_check: Step<{ readonly path: string }, { readonly restored: boolean }>;
};

export type StepName = keyof Steps;

export type StepOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "failed"; readonly error: string };

type ResultOf<N extends StepName, T> = keyof Steps[N]["result"] extends never
  ? []
  : [result: (done: T) => Steps[N]["result"]];

export type Trace = {
  step<N extends StepName, T>(
    name: N,
    start: Steps[N]["start"],
    perform: () => T,
    ...result: ResultOf<N, T>
  ): T;
  stepAsync<N extends StepName, T>(
    name: N,
    start: Steps[N]["start"],
    perform: () => Promise<T>,
    ...result: ResultOf<N, T>
  ): Promise<T>;
};

import type { Station } from "./order-contract";

export type Steps = {
  readonly run: { readonly act: string; readonly station: Station | null };
  readonly record: { readonly action: string };
  readonly act: { readonly act: string };
  readonly worktree_add: { readonly dir: string; readonly base: string };
  readonly worktree_remove: { readonly dir: string };
  readonly branch_delete: { readonly branch: string };
  readonly branch_move: { readonly repo: string; readonly branch: string; readonly to: string };
  readonly workspace_reset: { readonly dir: string; readonly head: string };
  readonly rebase_abort: { readonly dir: string };
  readonly rebase: { readonly dir: string; readonly onto: string };
  readonly land: { readonly repo: string; readonly head: string };
  readonly check: { readonly tree: string; readonly command: string };
  readonly lock: { readonly path: string };
  readonly turn_open: { readonly home: string };
  readonly turn_close: { readonly dir: string };
  readonly harness_spawn: { readonly cwd: string };
  readonly harness_wait: { readonly pid: number };
  readonly harness_kill: { readonly pid: number };
  readonly session_copy: { readonly session: string };
  readonly session_restore: { readonly session: string };
  readonly config_check: { readonly path: string };
};

export type StepName = keyof Steps;

export type StepOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "failed"; readonly error: string };

export type StepResult = Readonly<Record<string, string | number | boolean | null>>;

export type Trace = {
  readonly order: string;
  readonly cause: number;
  step<N extends StepName, T>(
    name: N,
    start: Steps[N],
    perform: () => T,
    result?: (done: T) => StepResult,
  ): T;
  stepAsync<N extends StepName, T>(
    name: N,
    start: Steps[N],
    perform: () => Promise<T>,
    result?: (done: T) => StepResult,
  ): Promise<T>;
};

import type { ContextShares } from "./worker-contract";

export type ContextCall = { readonly at: string; readonly context: number; readonly output: number };

export const NO_SHARES: ContextShares = { brief: 0, tools: 0, messages: 0 };

export const addShares = (sum: ContextShares, shares: ContextShares): ContextShares => ({
  brief: sum.brief + shares.brief,
  tools: sum.tools + shares.tools,
  messages: sum.messages + shares.messages,
});

export function contextShares(calls: readonly ContextCall[], results: readonly string[]): ContextShares {
  let read = NO_SHARES;
  let held = NO_SHARES;
  let previous: ContextCall | null = null;
  for (const current of calls) {
    if (previous === null) {
      held = { ...NO_SHARES, brief: current.context };
    } else if (current.context < previous.context) {
      held = { ...NO_SHARES, messages: current.context };
    } else {
      const growth = current.context - previous.context;
      const after = previous.at;
      const toolsReturned = results.some((at) => at > after && at <= current.at);
      const output = toolsReturned ? Math.min(previous.output, growth) : growth;
      held = addShares(held, { brief: 0, tools: growth - output, messages: output });
    }
    read = addShares(read, held);
    previous = current;
  }
  return read;
}

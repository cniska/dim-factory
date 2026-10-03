import { BUG, faulter } from "./coded-error";

const fault = faulter<{
  readonly unreachable: { readonly value: string };
  readonly invariant_failed: { readonly condition: string };
}>({
  unreachable: { message: ({ value }) => `unreachable: ${value}`, resolve: () => BUG },
  invariant_failed: {
    message: ({ condition }) => `invariant failed: ${condition}`,
    resolve: () => BUG,
  },
});

export function unreachable(value: never): never {
  throw fault("unreachable", { value: JSON.stringify(value) });
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw fault("invariant_failed", { condition: message });
}

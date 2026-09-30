export function unreachable(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invariant failed: ${message}`);
}

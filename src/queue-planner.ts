export const QUEUE_VERSION = 1 as const;

export const QUEUE_STATUSES = [
  "planned",
  "claimed",
  "running",
  "completed",
  "blocked",
  "fenced",
  "failed",
  "cancelled",
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type QueueTransition = {
  from: QueueStatus;
  to: QueueStatus;
  at: string;
  reason?: string;
};

export type QueueItem = {
  id: string;
  title: string;
  description?: string;
  dependencies: string[];
  status: QueueStatus;
  transitions: QueueTransition[];
};

export type QueueFile = {
  version: typeof QUEUE_VERSION;
  id: string;
  items: QueueItem[];
};

const terminalStatuses = new Set<QueueStatus>(["completed", "blocked", "fenced", "failed", "cancelled"]);

function isStatus(value: unknown): value is QueueStatus {
  return typeof value === "string" && (QUEUE_STATUSES as readonly string[]).includes(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function parseTransition(value: unknown, itemId: string): QueueTransition {
  if (typeof value !== "object" || value === null) throw new Error(`invalid transition for item: ${itemId}`);
  const transition = value as Record<string, unknown>;
  const from = transition.from;
  const to = transition.to;
  if (!isStatus(from) || !isStatus(to)) throw new Error(`invalid transition status for item: ${itemId}`);
  const result: QueueTransition = { from, to, at: requiredString(transition.at, "transition.at") };
  if (transition.reason !== undefined) result.reason = requiredString(transition.reason, "transition.reason");
  return result;
}

export function parseQueue(text: string): QueueFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("queue file is not valid JSON");
  }
  if (typeof value !== "object" || value === null) throw new Error("queue file must be an object");
  const source = value as Record<string, unknown>;
  if (source.version !== QUEUE_VERSION)
    throw new Error(`unsupported queue version: ${String(source.version)}`);
  const id = requiredString(source.id, "queue.id");
  if (!Array.isArray(source.items)) throw new Error("queue.items must be an array");
  const seen = new Set<string>();
  const items = source.items.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("queue item must be an object");
    const sourceItem = value as Record<string, unknown>;
    const itemId = requiredString(sourceItem.id, "item.id");
    if (seen.has(itemId)) throw new Error(`duplicate item: ${itemId}`);
    seen.add(itemId);
    if (
      !Array.isArray(sourceItem.dependencies) ||
      sourceItem.dependencies.some((dependency) => typeof dependency !== "string")
    ) {
      throw new Error(`item dependencies must be strings: ${itemId}`);
    }
    if (!isStatus(sourceItem.status)) throw new Error(`invalid item status: ${itemId}`);
    if (!Array.isArray(sourceItem.transitions))
      throw new Error(`item transitions must be an array: ${itemId}`);
    return {
      id: itemId,
      title: requiredString(sourceItem.title, `item.title (${itemId})`),
      ...(sourceItem.description === undefined
        ? {}
        : { description: requiredString(sourceItem.description, `item.description (${itemId})`) }),
      dependencies: [...sourceItem.dependencies],
      status: sourceItem.status,
      transitions: sourceItem.transitions.map((transition) => parseTransition(transition, itemId)),
    } as QueueItem;
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) throw new Error(`unknown dependency: ${dependency}`);
    }
  }
  assertAcyclic(items, byId);
  return { version: QUEUE_VERSION, id, items };
}

function assertAcyclic(items: QueueItem[], byId: Map<string, QueueItem>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}

export function readyItems(queue: QueueFile, limit = Number.POSITIVE_INFINITY): QueueItem[] {
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  return queue.items
    .filter(
      (item) =>
        item.status === "planned" &&
        item.dependencies.every((dependency) => byId.get(dependency)?.status === "completed"),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function transitionQueue(
  queue: QueueFile,
  itemId: string,
  status: QueueStatus,
  reason: string | undefined,
  at: string,
): QueueFile {
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item not found: ${itemId}`);
  if (terminalStatuses.has(item.status)) throw new Error("terminal item cannot transition");
  if (status === "claimed" && !readyItems(queue).some((candidate) => candidate.id === itemId)) {
    throw new Error("dependencies are not completed");
  }
  const transition: QueueTransition = {
    from: item.status,
    to: status,
    at,
    ...(reason === undefined ? {} : { reason }),
  };
  return {
    ...queue,
    items: queue.items.map((candidate) =>
      candidate.id === itemId
        ? { ...candidate, status, transitions: [...candidate.transitions, transition] }
        : candidate,
    ),
  };
}

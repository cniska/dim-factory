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
  job_id?: string;
};

export type QueueFile = {
  version: typeof QUEUE_VERSION;
  id: string;
  items: QueueItem[];
};

const terminalStatuses = new Set<QueueStatus>(["completed", "blocked", "fenced", "failed", "cancelled"]);
const transitions = new Map<QueueStatus, Set<QueueStatus>>([
  ["planned", new Set(["claimed", "blocked", "cancelled"])],
  ["claimed", new Set(["running", "blocked", "failed", "cancelled"])],
  ["running", new Set(["completed", "blocked", "fenced", "failed"])],
]);

const queueFields = new Set(["version", "id", "items"]);
const itemFields = new Set(["id", "title", "description", "dependencies", "status", "transitions", "job_id"]);
const transitionFields = new Set(["from", "to", "at", "reason"]);

function isStatus(value: unknown): value is QueueStatus {
  return typeof value === "string" && (QUEUE_STATUSES as readonly string[]).includes(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (
    Number.isNaN(Date.parse(timestamp)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
  ) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function assertFields(value: Record<string, unknown>, fields: Set<string>, name: string): void {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${name} has unknown field: ${field}`);
  }
}

function parseTransition(value: unknown, itemId: string): QueueTransition {
  if (typeof value !== "object" || value === null) throw new Error(`invalid transition for item: ${itemId}`);
  const transition = value as Record<string, unknown>;
  assertFields(transition, transitionFields, `transition for item ${itemId}`);
  const from = transition.from;
  const to = transition.to;
  if (!isStatus(from) || !isStatus(to)) throw new Error(`invalid transition status for item: ${itemId}`);
  if (!transitions.get(from)?.has(to)) throw new Error(`invalid transition for item: ${itemId}`);
  const result: QueueTransition = { from, to, at: requiredTimestamp(transition.at, "transition.at") };
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
  assertFields(source, queueFields, "queue file");
  if (source.version !== QUEUE_VERSION)
    throw new Error(`unsupported queue version: ${String(source.version)}`);
  const id = requiredString(source.id, "queue.id");
  if (!Array.isArray(source.items)) throw new Error("queue.items must be an array");
  const seen = new Set<string>();
  const items = source.items.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("queue item must be an object");
    const sourceItem = value as Record<string, unknown>;
    assertFields(sourceItem, itemFields, "queue item");
    const itemId = requiredString(sourceItem.id, "item.id");
    if (seen.has(itemId)) throw new Error(`duplicate item: ${itemId}`);
    seen.add(itemId);
    if (
      !Array.isArray(sourceItem.dependencies) ||
      sourceItem.dependencies.some((dependency) => typeof dependency !== "string")
    ) {
      throw new Error(`item dependencies must be strings: ${itemId}`);
    }
    if (new Set(sourceItem.dependencies).size !== sourceItem.dependencies.length) {
      throw new Error(`duplicate dependency: ${itemId}`);
    }
    if (!isStatus(sourceItem.status)) throw new Error(`invalid item status: ${itemId}`);
    if (!Array.isArray(sourceItem.transitions))
      throw new Error(`item transitions must be an array: ${itemId}`);
    const transitionsForItem = sourceItem.transitions.map((transition) =>
      parseTransition(transition, itemId),
    );
    let statusBeforeHistory: QueueStatus = "planned";
    for (const transition of transitionsForItem) {
      if (transition.from !== statusBeforeHistory)
        throw new Error(`transition history does not chain: ${itemId}`);
      statusBeforeHistory = transition.to;
    }
    if (statusBeforeHistory !== sourceItem.status) {
      throw new Error(`transition history does not match status: ${itemId}`);
    }
    return {
      id: itemId,
      title: requiredString(sourceItem.title, `item.title (${itemId})`),
      ...(sourceItem.description === undefined
        ? {}
        : { description: requiredString(sourceItem.description, `item.description (${itemId})`) }),
      dependencies: [...sourceItem.dependencies],
      status: sourceItem.status,
      transitions: transitionsForItem,
      ...(sourceItem.job_id === undefined
        ? {}
        : { job_id: requiredString(sourceItem.job_id, `item.job_id (${itemId})`) }),
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
  for (const item of items) {
    if (visited.has(item.id)) continue;
    const stack: { id: string; nextDependency: number }[] = [{ id: item.id, nextDependency: 0 }];
    visiting.add(item.id);
    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      if (!current) throw new Error("dependency traversal failed");
      const dependencies = byId.get(current.id)?.dependencies ?? [];
      if (current.nextDependency === dependencies.length) {
        stack.pop();
        visiting.delete(current.id);
        visited.add(current.id);
        continue;
      }
      const dependency = dependencies[current.nextDependency++];
      if (dependency === undefined) throw new Error("dependency traversal failed");
      if (visiting.has(dependency)) throw new Error("dependency cycle");
      if (visited.has(dependency)) continue;
      visiting.add(dependency);
      stack.push({ id: dependency, nextDependency: 0 });
    }
  }
}

export function readyItems(queue: QueueFile, limit = Number.POSITIVE_INFINITY): QueueItem[] {
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  return queue.items
    .filter(
      (item) =>
        item.status === "planned" &&
        item.dependencies.every((dependency) => byId.get(dependency)?.status === "completed"),
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
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
  if (!transitions.get(item.status)?.has(status)) throw new Error("invalid status transition");
  const timestamp = requiredTimestamp(at, "transition.at");
  const normalizedReason = reason === undefined ? undefined : requiredString(reason, "transition.reason");
  if (status === "claimed" && !readyItems(queue).some((candidate) => candidate.id === itemId)) {
    throw new Error("dependencies are not completed");
  }
  const transition: QueueTransition = {
    from: item.status,
    to: status,
    at: timestamp,
    ...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
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

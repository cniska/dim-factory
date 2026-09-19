import type { Database } from "bun:sqlite";
import { readFlags, requiredFlag } from "./flags";
import {
  addItem,
  QUEUE_PRIORITIES,
  QUEUE_STATUSES,
  type QueuePriority,
  type QueueStatus,
  readyItems,
  transitionItem,
} from "./queue-store";

export class QueueCommandError extends Error {}

export const QUEUE_USAGE = `usage: dim queue add <item-id> --title "..." [--description "..."]
                     [--priority <${QUEUE_PRIORITIES.join("|")}>] [--needs <id,id>]
                     [--order <order-id>] [--queue <queue-id>]
       dim queue ready [--limit <n>] [--queue <queue-id>]
       dim queue transition <item-id> <${QUEUE_STATUSES.join("|")}> [--reason "..."]
                     [--order <order-id>] [--queue <queue-id>]

The queue defaults to this checkout's owner/repo, so an item belongs to the project
it is built in rather than to wherever the command was typed.`;

const fail = (message: string): Error => new QueueCommandError(message);

function isPriority(value: string): value is QueuePriority {
  return (QUEUE_PRIORITIES as readonly string[]).includes(value);
}

function isStatus(value: string): value is QueueStatus {
  return (QUEUE_STATUSES as readonly string[]).includes(value);
}

function positiveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw fail("--limit takes a positive whole number");
  return limit;
}

export function runQueueCommand(db: Database, args: string[], defaultQueue: string | null): string {
  const action = args[0];
  const queueOf = (given: Map<string, string>): string => {
    const queue = given.get("--queue") ?? defaultQueue;
    if (!queue) throw fail("--queue is required outside a checkout with a remote");
    return queue;
  };
  const now = new Date().toISOString();

  if (action === "add") {
    const id = args[1];
    if (!id || id.startsWith("--")) throw fail(QUEUE_USAGE);
    const given = readFlags(
      args.slice(2),
      ["--title", "--description", "--priority", "--needs", "--order", "--queue"],
      fail,
    );
    const priority = given.get("--priority");
    if (priority !== undefined && !isPriority(priority)) throw fail(`${priority} is not a priority`);
    const needs = given.get("--needs");
    const item = addItem(
      db,
      {
        queueId: queueOf(given),
        id,
        title: requiredFlag(given, "--title", fail),
        ...(given.get("--description") === undefined ? {} : { description: given.get("--description") }),
        ...(priority === undefined ? {} : { priority }),
        ...(needs === undefined ? {} : { dependsOn: needs.split(",").map((one) => one.trim()) }),
        ...(given.get("--order") === undefined ? {} : { discoveredByOrderId: given.get("--order") }),
      },
      now,
    );
    return `added ${item.id} to ${item.queueId}`;
  }

  if (action === "ready") {
    const given = readFlags(args.slice(1), ["--limit", "--queue"], fail);
    const items = readyItems(db, queueOf(given), positiveLimit(given.get("--limit")));
    // JSON because a station reads this rather than a person: an item's own words reach the
    // claim unedited only if nothing in between reformats them.
    return JSON.stringify(items, null, 2);
  }

  if (action === "transition") {
    const id = args[1];
    const status = args[2];
    if (!id || !status || !isStatus(status)) throw fail(QUEUE_USAGE);
    const given = readFlags(args.slice(3), ["--reason", "--order", "--queue"], fail);
    const item = transitionItem(db, queueOf(given), id, status, now, {
      ...(given.get("--reason") === undefined ? {} : { reason: given.get("--reason") }),
      ...(given.get("--order") === undefined ? {} : { orderId: given.get("--order") }),
    });
    return `${item.id} is ${item.status}`;
  }

  throw fail(QUEUE_USAGE);
}

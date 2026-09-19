import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  addItem,
  type QueuePriority,
  QueueStoreError,
  readItem,
  readyItems,
  transitionItem,
} from "./queue-store";
import { SCHEMA_SQL } from "./schema";

const QUEUE = "cniska/dim-factory";
const AT = "2026-09-19T09:00:00.000Z";

function store(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function add(db: Database, id: string, extra: { dependsOn?: string[]; priority?: QueuePriority } = {}) {
  return addItem(db, { queueId: QUEUE, id, title: `Do ${id}`, ...extra }, AT);
}

describe("adding to a queue", () => {
  test("an added item is planned and waits on nothing", () => {
    const db = store();

    const item = add(db, "first");

    expect(item).toMatchObject({ status: "planned", priority: "unset", dependsOn: [] });
    db.close();
  });

  test("the same id twice is refused", () => {
    const db = store();
    add(db, "first");

    expect(() => add(db, "first")).toThrow(expect.objectContaining({ code: "duplicate_item" }));

    db.close();
  });

  test("a dependency on an item that is not there is refused, and adds nothing", () => {
    const db = store();

    expect(() => add(db, "second", { dependsOn: ["missing"] })).toThrow(
      expect.objectContaining({ code: "unknown_dependency" }),
    );
    expect(readItem(db, QUEUE, "second")).toBeUndefined();
    db.close();
  });
});

describe("what is ready to take", () => {
  test("an item waiting on an unfinished one is not offered", () => {
    const db = store();
    add(db, "first");
    add(db, "second", { dependsOn: ["first"] });

    expect(readyItems(db, QUEUE).map((item) => item.id)).toEqual(["first"]);

    transitionItem(db, QUEUE, "first", "claimed", AT);
    transitionItem(db, QUEUE, "first", "completed", AT);
    expect(readyItems(db, QUEUE).map((item) => item.id)).toEqual(["second"]);
    db.close();
  });

  test("urgent comes first and unset comes last, then oldest", () => {
    const db = store();
    addItem(db, { queueId: QUEUE, id: "plain", title: "Plain" }, "2026-09-19T08:00:00.000Z");
    addItem(
      db,
      { queueId: QUEUE, id: "later-low", title: "Low", priority: "low" },
      "2026-09-19T10:00:00.000Z",
    );
    addItem(db, { queueId: QUEUE, id: "hot", title: "Hot", priority: "urgent" }, "2026-09-19T09:00:00.000Z");

    expect(readyItems(db, QUEUE).map((item) => item.id)).toEqual(["hot", "later-low", "plain"]);
    db.close();
  });

  test("a queue is only its own items", () => {
    const db = store();
    add(db, "mine");
    addItem(db, { queueId: "someone/else", id: "theirs", title: "Theirs" }, AT);

    expect(readyItems(db, QUEUE).map((item) => item.id)).toEqual(["mine"]);
    db.close();
  });
});

describe("moving an item", () => {
  test("a move is recorded with the order that caused it", () => {
    const db = store();
    add(db, "first");

    transitionItem(db, QUEUE, "first", "claimed", AT, { orderId: "order-1", reason: "taken" });

    expect(
      db.query("SELECT from_status, to_status, order_id, reason FROM queue_item_transition").all(),
    ).toEqual([{ from_status: "planned", to_status: "claimed", order_id: "order-1", reason: "taken" }]);
    db.close();
  });

  test("a failed order puts its item back rather than leaving it held", () => {
    const db = store();
    add(db, "first");
    transitionItem(db, QUEUE, "first", "claimed", AT);

    transitionItem(db, QUEUE, "first", "planned", AT, { reason: "the worker never started" });

    expect(readyItems(db, QUEUE).map((item) => item.id)).toEqual(["first"]);
    db.close();
  });

  test("a completed item takes no further move", () => {
    const db = store();
    add(db, "first");
    transitionItem(db, QUEUE, "first", "claimed", AT);
    transitionItem(db, QUEUE, "first", "completed", AT);

    expect(() => transitionItem(db, QUEUE, "first", "claimed", AT)).toThrow(
      expect.objectContaining({ code: "terminal_item" }),
    );
    db.close();
  });

  test("claiming an item whose dependency is open is refused", () => {
    const db = store();
    add(db, "first");
    add(db, "second", { dependsOn: ["first"] });

    expect(() => transitionItem(db, QUEUE, "second", "claimed", AT)).toThrow(
      expect.objectContaining({ code: "dependencies_open" }),
    );
    db.close();
  });

  test("a move the shape does not allow is refused by code", () => {
    const db = store();
    add(db, "first");

    try {
      transitionItem(db, QUEUE, "first", "completed", AT);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueStoreError);
      expect((error as QueueStoreError).code).toBe("invalid_transition");
    }
    db.close();
  });
});

import { describe, expect, test } from "bun:test";
import { parseQueue, type QueueFile, readyItems, transitionQueue } from "./queue-planner";

const queue = (items: Partial<QueueFile["items"][number]>[]): string =>
  JSON.stringify({
    version: 1,
    id: "build-order",
    items: items.map((item, index) => ({
      id: item.id ?? `item-${index + 1}`,
      title: item.title ?? `Item ${index + 1}`,
      dependencies: item.dependencies ?? [],
      status: item.status ?? "planned",
      transitions: item.transitions ?? [],
    })),
  });

describe("queue planner", () => {
  test("parses the explicit format and selects planned items with completed dependencies", () => {
    const parsed = parseQueue(
      queue([
        { id: "b", dependencies: ["a"] },
        { id: "a", status: "completed" },
        { id: "c", status: "claimed" },
      ]),
    );

    expect(parsed.id).toBe("build-order");
    expect(readyItems(parsed).map((item) => item.id)).toEqual(["b"]);
  });

  test("selects ready items deterministically and applies a limit", () => {
    const parsed = parseQueue(queue([{ id: "z" }, { id: "a" }, { id: "m" }]));

    expect(readyItems(parsed, 2).map((item) => item.id)).toEqual(["a", "m"]);
  });

  test("rejects missing dependencies and dependency cycles", () => {
    expect(() => parseQueue(queue([{ id: "a", dependencies: ["missing"] }]))).toThrow(
      "unknown dependency: missing",
    );
    expect(() =>
      parseQueue(
        queue([
          { id: "a", dependencies: ["b"] },
          { id: "b", dependencies: ["a"] },
        ]),
      ),
    ).toThrow("dependency cycle");
  });

  test("serializes a status transition with its reason", () => {
    const parsed = parseQueue(queue([{ id: "a" }]));

    const updated = transitionQueue(
      parsed,
      "a",
      "claimed",
      "assigned to an isolated job",
      "2026-09-18T10:00:00.000Z",
    );

    expect(updated.items[0]).toMatchObject({ status: "claimed" });
    expect(updated.items[0]?.transitions).toEqual([
      {
        from: "planned",
        to: "claimed",
        reason: "assigned to an isolated job",
        at: "2026-09-18T10:00:00.000Z",
      },
    ]);
  });

  test("prevents blocked work from being claimed and terminal work from changing", () => {
    const blocked = parseQueue(queue([{ id: "a", dependencies: ["b"] }, { id: "b" }]));
    expect(() => transitionQueue(blocked, "a", "claimed", undefined, "2026-09-18T10:00:00.000Z")).toThrow(
      "dependencies are not completed",
    );

    const completed = parseQueue(queue([{ id: "a", status: "completed" }]));
    expect(() => transitionQueue(completed, "a", "failed", undefined, "2026-09-18T10:00:00.000Z")).toThrow(
      "terminal item cannot transition",
    );
  });
});

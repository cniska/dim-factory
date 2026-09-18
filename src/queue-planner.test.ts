import { describe, expect, test } from "bun:test";
import {
  parseQueue,
  type QueueFile,
  type QueueTransition,
  readyItems,
  transitionQueue,
} from "./queue-planner";

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
        {
          id: "a",
          status: "completed",
          transitions: [
            { from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" },
            { from: "claimed", to: "running", at: "2026-09-18T10:01:00.000Z" },
            { from: "running", to: "completed", at: "2026-09-18T10:02:00.000Z" },
          ],
        },
        {
          id: "c",
          status: "claimed",
          transitions: [{ from: "planned", to: "claimed", at: "2026-09-18T10:03:00.000Z" }],
        },
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

  test("rejects malformed source fields and inconsistent transition history", () => {
    const malformed = JSON.parse(queue([{ id: "a" }])) as Record<string, unknown>;
    malformed.extra = true;
    expect(() => parseQueue(JSON.stringify(malformed))).toThrow("queue file has unknown field: extra");
    expect(() => parseQueue(queue([{ id: "a", dependencies: ["a", "a"] }]))).toThrow(
      "duplicate dependency: a",
    );
    const itemExtra = JSON.parse(queue([{ id: "a" }])) as { items: Record<string, unknown>[] };
    const itemExtraSource = itemExtra.items[0];
    if (!itemExtraSource) throw new Error("test fixture is missing an item");
    itemExtraSource.extra = true;
    expect(() => parseQueue(JSON.stringify(itemExtra))).toThrow("queue item has unknown field: extra");
    const transitionExtra = JSON.parse(
      queue([
        {
          id: "a",
          status: "claimed",
          transitions: [{ from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" }],
        },
      ]),
    ) as { items: { transitions: Record<string, unknown>[] }[] };
    const transitionExtraItem = transitionExtra.items[0];
    const transitionExtraSource = transitionExtraItem?.transitions[0];
    if (!transitionExtraSource) throw new Error("test fixture is missing a transition");
    transitionExtraSource.extra = true;
    expect(() => parseQueue(JSON.stringify(transitionExtra))).toThrow("unknown field: extra");
    expect(() =>
      parseQueue(
        queue([
          {
            id: "a",
            status: "running",
            transitions: [{ from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" }],
          },
        ]),
      ),
    ).toThrow("transition history does not match status: a");
    expect(() =>
      parseQueue(
        queue([
          {
            id: "a",
            status: "claimed",
            transitions: [{ from: "planned", to: "claimed", at: "not-a-time" }],
          },
        ]),
      ),
    ).toThrow("transition.at must be an ISO timestamp");
    const duplicateItems = JSON.parse(queue([{ id: "a" }, { id: "a" }])) as Record<string, unknown>;
    expect(() => parseQueue(JSON.stringify(duplicateItems))).toThrow("duplicate item: a");
    expect(() =>
      parseQueue(
        queue([
          {
            id: "a",
            status: "running",
            transitions: [{ from: "planned", to: "running", at: "2026-09-18T10:00:00.000Z" }],
          },
        ]),
      ),
    ).toThrow("invalid transition for item: a");
    expect(() =>
      parseQueue(
        queue([
          {
            id: "a",
            status: "blocked",
            transitions: [
              { from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" },
              { from: "planned", to: "blocked", at: "2026-09-18T10:01:00.000Z" },
            ],
          },
        ]),
      ),
    ).toThrow("transition history does not chain: a");
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

  test("preserves a job link when reading the queue source", () => {
    const source = JSON.parse(queue([{ id: "a" }])) as { items: Record<string, unknown>[] };
    const item = source.items[0];
    if (!item) throw new Error("test fixture is missing an item");
    item.job_id = "job-1";
    expect(parseQueue(JSON.stringify(source)).items[0]?.job_id).toBe("job-1");
  });

  test("rejects empty reasons and accepts ISO timestamps with offsets", () => {
    const parsed = parseQueue(queue([{ id: "a" }]));
    expect(() => transitionQueue(parsed, "a", "claimed", "", "2026-09-18T10:00:00+02:00")).toThrow(
      "transition.reason must be a non-empty string",
    );
    expect(
      transitionQueue(parsed, "a", "claimed", undefined, "2026-09-18T10:00:00+02:00").items[0]?.transitions[0]
        ?.at,
    ).toBe("2026-09-18T10:00:00+02:00");
  });

  test("prevents blocked work from being claimed and terminal work from changing", () => {
    const blocked = parseQueue(queue([{ id: "a", dependencies: ["b"] }, { id: "b" }]));
    expect(() => transitionQueue(blocked, "a", "claimed", undefined, "2026-09-18T10:00:00.000Z")).toThrow(
      "dependencies are not completed",
    );

    for (const status of ["completed", "blocked", "fenced", "failed", "cancelled"] as const) {
      const history = {
        completed: [
          { from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" },
          { from: "claimed", to: "running", at: "2026-09-18T10:01:00.000Z" },
          { from: "running", to: "completed", at: "2026-09-18T10:02:00.000Z" },
        ],
        blocked: [{ from: "planned", to: "blocked", at: "2026-09-18T10:00:00.000Z" }],
        fenced: [
          { from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" },
          { from: "claimed", to: "running", at: "2026-09-18T10:01:00.000Z" },
          { from: "running", to: "fenced", at: "2026-09-18T10:02:00.000Z" },
        ],
        failed: [
          { from: "planned", to: "claimed", at: "2026-09-18T10:00:00.000Z" },
          { from: "claimed", to: "failed", at: "2026-09-18T10:01:00.000Z" },
        ],
        cancelled: [{ from: "planned", to: "cancelled", at: "2026-09-18T10:00:00.000Z" }],
      }[status] as QueueTransition[];
      const completed = parseQueue(
        queue([
          {
            id: "a",
            status,
            transitions: history,
          },
        ]),
      );
      expect(() => transitionQueue(completed, "a", "failed", undefined, "2026-09-18T10:00:00.000Z")).toThrow(
        "terminal item cannot transition",
      );
    }
  });

  test("allows only the lifecycle transitions owned by the planner", () => {
    const parsed = parseQueue(queue([{ id: "a" }]));

    expect(() => transitionQueue(parsed, "a", "running", undefined, "2026-09-18T10:00:00.000Z")).toThrow(
      "invalid status transition",
    );
  });
});

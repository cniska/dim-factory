import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQueue } from "./queue-planner";

const root = join(import.meta.dir, "..");
const queue = parseQueue(readFileSync(join(root, "queue.json"), "utf8"));
const buildOrder = readFileSync(join(root, "docs", "build-order.md"), "utf8");

function idsInBuildOrder(): string[] {
  return [...buildOrder.matchAll(/\(`([a-z0-9-]+)`\)/g)].map((match) => match[1] as string);
}

describe("this repo's queue file", () => {
  test("parses and names itself", () => {
    expect(queue.id).toBe("dim-factory");
    expect(queue.items.length).toBeGreaterThan(0);
  });

  test("gives every item a title and a statement", () => {
    for (const item of queue.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("carries the same ids as the build order", () => {
    expect([...idsInBuildOrder()].sort()).toEqual(queue.items.map((item) => item.id).sort());
  });

  test("marks an id once in the build order", () => {
    const ids = idsInBuildOrder();
    expect(new Set(ids).size).toBe(ids.length);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueueCommand } from "./queue-command";

const source = JSON.stringify({
  version: 1,
  id: "build-order",
  items: [
    { id: "b", title: "Second", dependencies: ["a"], status: "planned", transitions: [] },
    { id: "a", title: "First", dependencies: [], status: "planned", transitions: [] },
  ],
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dim-queue-"));
  const path = join(directory, "queue.json");
  await writeFile(path, source);
  return path;
}

describe("queue command", () => {
  test("prints ready items in stable order and honors a limit", async () => {
    const path = await fixture();

    expect(await runQueueCommand(["ready", path, "--limit", "1"])).toBe(
      '[{"id":"a","title":"First","status":"planned"}]',
    );
  });

  test("writes a validated transition back to the tracked file", async () => {
    const path = await fixture();

    expect(
      await runQueueCommand([
        "transition",
        path,
        "a",
        "claimed",
        "--reason",
        "isolated job",
        "--at",
        "2026-09-18T10:00:00.000Z",
      ]),
    ).toBe('{"id":"a","status":"claimed"}');
    const updated = JSON.parse(await readFile(path, "utf8")) as {
      items: {
        id: string;
        status: string;
        transitions: { from: string; to: string; reason?: string; at: string }[];
      }[];
    };
    const item = updated.items.find((candidate) => candidate.id === "a");
    expect(item?.status).toBe("claimed");
    expect(item?.transitions).toEqual([
      { from: "planned", to: "claimed", reason: "isolated job", at: "2026-09-18T10:00:00.000Z" },
    ]);
  });

  test("releases the queue lock after a rejected transition", async () => {
    const path = await fixture();
    await expect(runQueueCommand(["transition", path, "a", "running"])).rejects.toThrow(
      "invalid status transition",
    );
    await expect(
      runQueueCommand(["transition", path, "a", "claimed", "--at", "2026-09-18T10:00:00.000Z"]),
    ).resolves.toBe('{"id":"a","status":"claimed"}');
  });

  test("refuses unknown commands and missing arguments", async () => {
    const path = await fixture();

    await expect(runQueueCommand(["unknown", path])).rejects.toThrow("usage: dim queue");
    await expect(runQueueCommand(["ready", path, "--limit", "0"])).rejects.toThrow(
      "limit must be a positive integer",
    );
    await expect(runQueueCommand(["ready", path, "--unknown", "1"])).rejects.toThrow("unknown option");
    await expect(runQueueCommand(["ready", path, "--limit", "1", "extra"])).rejects.toThrow("usage");
  });
});

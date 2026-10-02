import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendAct } from "./station-ops";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("a worker's act sent to its turn", () => {
  test("is refused as no turn when the turn closes without replying", async () => {
    const root = mkdtempSync(join(tmpdir(), "dim-turn-"));
    roots.push(root);
    const socket = join(root, "s");
    const server = Bun.listen({
      unix: socket,
      socket: {
        data(client) {
          client.end();
        },
      },
    });
    try {
      await expect(sendAct({ act: "slice_submit" }, { DIM_TURN_SOCKET: socket })).rejects.toMatchObject({
        code: "no_turn",
      });
    } finally {
      server.stop(true);
    }
  });
});

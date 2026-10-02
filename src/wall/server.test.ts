import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import wallServeConfig from "../../bunfig.toml";
import { openDb } from "../db";
import type { LogEntry } from "../order-contract";
import { seedEntry, seedOperator } from "../record-seed.test-support";
import { wallHandler } from "./server";

const WALL_PAGE = new URL("./index.html", import.meta.url).pathname;
const ORDER = "k7m2qx4d";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const ADDED: LogEntry = {
  seq: 1,
  ts: "2026-10-02T10:00:00.000Z",
  by: { kind: "worker", worker: "hinge-1", session: "s-op" },
  action: "order_added",
  details: { title: "Greet the reader", description: "Add a greeting.", project: "acme/widgets" },
};

const RUN: LogEntry = {
  seq: 2,
  ts: "2026-10-02T10:01:00.000Z",
  by: { kind: "worker", worker: "hinge-1", session: "s-op" },
  action: "order_run",
  details: {},
};

function record(): { readonly path: string; readonly db: Database } {
  const root = mkdtempSync(join(tmpdir(), "dim-wall-"));
  roots.push(root);
  const path = join(root, "sessions.db");
  const db = openDb(path);
  seedOperator(db, "hinge-1", "acme/widgets");
  return { path, db };
}

type Socket = {
  readonly data: { readonly order: string | null };
  readonly sent: string[];
  send(message: string): number;
};

function socket(order: string | null): Socket {
  const sent: string[] = [];
  return { data: { order }, sent, send: (message) => sent.push(message) };
}

const pushes = (s: Socket) => s.sent.map((message) => JSON.parse(message));

const upgrading = { upgrade: () => true };

describe("serving", () => {
  test("answers only a request addressed to a loopback host, so a rebound name reads nothing", () => {
    const wall = wallHandler(record().path);
    const status = (url: string) => wall.fetch(new Request(url), upgrading)?.status;

    expect(status("http://attacker.example:7326/ws")).toBe(403);
    expect(status(`http://attacker.example:7326/ws?order=${ORDER}`)).toBe(403);
    expect(status("http://attacker.example:7326/wall.woff2")).toBe(403);
    expect(status("http://localhost:7326/wall.woff2")).toBe(200);
  });

  test("opens a socket only to a page the wall served", () => {
    const wall = wallHandler(record().path);
    const upgraded: Request[] = [];
    const server = { upgrade: (request: Request) => upgraded.push(request) > 0 };
    const open = (origin: string) =>
      wall.fetch(new Request("http://127.0.0.1:7326/ws", { headers: { origin } }), server);

    expect(open("https://attacker.example")?.status).toBe(403);
    expect(open("http://localhost:7326")?.status).toBe(403);
    expect(upgraded).toHaveLength(0);
    expect(open("http://127.0.0.1:7326")).toBeUndefined();
    expect(upgraded).toHaveLength(1);
  });

  test("reads only through its sockets, has no control route and refuses a socket for something not an order", () => {
    const wall = wallHandler(record().path);
    const status = (path: string, init?: RequestInit) =>
      wall.fetch(new Request(`http://127.0.0.1:7326${path}`, init), upgrading)?.status;

    expect(status("/api/snapshot")).toBe(404);
    expect(status(`/api/order/${ORDER}`)).toBe(404);
    expect(status("/api/control", { method: "POST", body: "{}" })).toBe(404);
    expect(status("/ws?order=not-an-order")).toBe(404);
  });

  test("bundles a page whose script and stylesheet load with the plugins the server uses", async () => {
    const plugins = await Promise.all(
      (wallServeConfig as { serve: { static: { plugins: string[] } } }).serve.static.plugins.map(
        async (name) => (await import(name)).default as Bun.BunPlugin,
      ),
    );
    const built = await Bun.build({ entrypoints: [WALL_PAGE], plugins });
    expect(built.success).toBe(true);
    const html = (await built.outputs.find((output) => output.path.endsWith(".html"))?.text()) ?? "";
    const script = built.outputs.find((output) => output.path.endsWith(".js"));
    const style = built.outputs.find((output) => output.path.endsWith(".css"));
    expect(html).toContain('id="root"');
    expect(html).toContain(basename(script?.path ?? "missing.js"));
    expect(html).toContain(basename(style?.path ?? "missing.css"));
    expect(await style?.text()).toContain("grid-cols-3");
  });
});

describe("pushing the record", () => {
  test("sends the board when a socket opens, again only once the record changes, and ignores what a page sends", () => {
    const { path, db } = record();
    seedEntry(db, ORDER, ADDED);
    const wall = wallHandler(path);
    const board = socket(null);

    wall.websocket.open(board);
    wall.tick();
    expect(pushes(board)).toEqual([
      {
        kind: "snapshot",
        snapshot: {
          orders: [
            {
              id: ORDER,
              title: "Greet the reader",
              project: "acme/widgets",
              description: "Add a greeting.",
              station: null,
              worker: null,
              status: "queued",
              lastEventAt: "2026-10-02T10:00:00.000Z",
              next: null,
            },
          ],
          totals: { queued: 1, running: 0, shipped: 0 },
        },
      },
    ]);

    wall.websocket.message();
    seedEntry(db, ORDER, RUN);
    wall.tick();
    expect(pushes(board)).toHaveLength(2);
    expect(pushes(board)[1].snapshot.orders[0].lastEventAt).toBe("2026-10-02T10:01:00.000Z");
  });

  test("pushes an open order to its own socket alone as new entries arrive", () => {
    const { path, db } = record();
    seedEntry(db, ORDER, ADDED);
    const wall = wallHandler(path);
    const board = socket(null);
    const item = socket(ORDER);

    wall.websocket.open(board);
    wall.websocket.open(item);
    expect(pushes(item)[0]).toMatchObject({ kind: "order", view: { order: { id: ORDER }, plan: null } });
    expect(pushes(item)[0].view.entries.map((entry: { action: string }) => entry.action)).toEqual([
      "order_added",
    ]);

    seedEntry(db, ORDER, RUN);
    wall.tick();
    expect(pushes(item)).toHaveLength(2);
    expect(pushes(item)[1].view.entries.map((entry: { action: string }) => entry.action)).toEqual([
      "order_added",
      "order_run",
    ]);
    expect(pushes(board).every((push) => push.kind === "snapshot")).toBe(true);

    wall.websocket.close(item);
    wall.tick();
    expect(pushes(item)).toHaveLength(2);
  });

  test("sends a refusal with its code for an order the record does not hold", () => {
    const wall = wallHandler(record().path);
    const item = socket(ORDER);

    wall.websocket.open(item);
    expect(pushes(item)).toEqual([
      { kind: "failure", failure: expect.objectContaining({ code: "no_order", meta: { order: ORDER } }) },
    ]);
  });

  test("says the record is another version rather than reading it", () => {
    const { path, db } = record();
    seedEntry(db, ORDER, ADDED);
    db.run("PRAGMA user_version = 1");
    db.close();
    const board = socket(null);

    wallHandler(path).websocket.open(board);
    expect(pushes(board)).toEqual([
      { kind: "failure", failure: expect.objectContaining({ code: "record_version" }) },
    ]);
  });
});

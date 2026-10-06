import type { Database } from "bun:sqlite";
import { invariant } from "../assert";
import { isRefusal, recordOf } from "../coded-error";
import { openReadOnly } from "../db-read";
import { OrderId } from "../order-contract";
import { listOrders, showOrder } from "../order-ops";
import { tokensOf } from "../worker-ops";
import wallPage from "./index.html";
import { hearRecordWrites } from "./record-notices";
import { itemViewOf, snapshotOf } from "./views";
import type { BoardPush, OrderPush } from "./wall-contract";

const FONT = new URL("./fonts/jetbrains-mono-latin.woff2", import.meta.url);

type Topic = { readonly order: string | null };

type WallSocket = Pick<Bun.ServerWebSocket<Topic>, "send" | "data">;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const forbidden = (): Response => new Response("Forbidden", { status: 403 });

const notFound = (): Response => new Response("Not found", { status: 404 });

function readRecord<T>(path: string, read: (db: Database) => T): T {
  const db = openReadOnly(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function pushFor(path: string, { order }: Topic): string {
  try {
    const push: BoardPush | OrderPush =
      order === null
        ? { kind: "snapshot", snapshot: readRecord(path, (db) => snapshotOf(listOrders(db))) }
        : {
            kind: "order",
            view: readRecord(path, (db) =>
              itemViewOf(showOrder(db, order), (worker) => tokensOf(db, worker)),
            ),
          };
    return JSON.stringify(push);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return JSON.stringify({ kind: "failure", failure: recordOf(error) } satisfies BoardPush);
  }
}

function topicOf(url: URL): Topic | null {
  const order = url.searchParams.get("order");
  if (order === null) return { order: null };
  return OrderId.safeParse(order).success ? { order } : null;
}

export function wallHandler(path: string) {
  const sent = new Map<WallSocket, string>();
  const send = (socket: WallSocket, pushes: Map<string | null, string>) => {
    const key = socket.data.order;
    const push = pushes.get(key) ?? pushFor(path, socket.data);
    pushes.set(key, push);
    if (sent.get(socket) === push) return;
    sent.set(socket, push);
    socket.send(push);
  };
  return {
    tick() {
      const pushes = new Map<string | null, string>();
      for (const socket of sent.keys()) send(socket, pushes);
    },
    fetch(request: Request, server: Pick<Bun.Server<Topic>, "upgrade">): Response | undefined {
      const url = new URL(request.url);
      if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return forbidden();
      if (url.pathname === "/wall.woff2")
        return new Response(Bun.file(FONT), {
          headers: { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" },
        });
      if (url.pathname !== "/ws") return notFound();
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) return forbidden();
      const topic = topicOf(url);
      if (topic === null) return notFound();
      if (server.upgrade(request, { data: topic })) return;
      return notFound();
    },
    websocket: {
      open(socket: WallSocket) {
        sent.set(socket, "");
        send(socket, new Map());
      },
      close(socket: WallSocket) {
        sent.delete(socket);
      },
      message() {},
    },
  };
}

export async function serveWall(options: {
  readonly port: number;
  readonly path: string;
  readonly hmr: boolean;
}): Promise<ReturnType<typeof Bun.serve>> {
  const { tick, fetch, websocket } = wallHandler(options.path);
  const server = Bun.serve<Topic>({
    hostname: "127.0.0.1",
    port: options.port,
    routes: { "/": wallPage },
    development: options.hmr ? { hmr: true } : false,
    fetch,
    websocket,
  });
  const port = server.port;
  invariant(port !== undefined, "a wall served on a port knows its port");
  await hearRecordWrites(options.path, port, tick);
  return server;
}

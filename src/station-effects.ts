import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Turn } from "./station";

const SOCKET_ROOT = "/tmp";

export type TurnDir = Omit<Turn, "home"> & { readonly dir: string };

export function openTurnDir(): TurnDir {
  const dir = realpathSync(mkdtempSync(join(SOCKET_ROOT, "dim-")));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  return { dir, tmp, socket: join(dir, "s") };
}

export function makeHome(home: string): string {
  mkdirSync(home, { recursive: true });
  return home;
}

export function removeTurnDir(turn: TurnDir): void {
  rmSync(turn.dir, { recursive: true, force: true });
}

export type Listening = { stop(): void };

export function listen(socket: string, serve: (line: string) => Promise<string>): Listening {
  const server = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(client) {
        client.data = { buffer: "" };
      },
      async data(client, chunk) {
        client.data.buffer += chunk.toString();
        const end = client.data.buffer.indexOf("\n");
        if (end === -1) return;
        client.write(`${await serve(client.data.buffer.slice(0, end))}\n`);
        client.end();
      },
    },
  });
  return { stop: () => server.stop(true) };
}

export function send(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    Bun.connect({
      unix: socket,
      socket: {
        open(server) {
          server.write(`${line}\n`);
        },
        data(_, chunk) {
          reply += chunk.toString();
        },
        close() {
          resolve(reply);
        },
        error(_, error) {
          reject(error);
        },
        connectError(_, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

export function copySession(transcript: string, sessions: string, session: string): void {
  mkdirSync(sessions, { recursive: true });
  copyFileSync(transcript, join(sessions, `${session}.jsonl`));
}

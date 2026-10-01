import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./assert";
import type { Turn } from "./station";

const SOCKET_ROOT = "/tmp";

export function openTurn(home: string): Turn {
  mkdirSync(home, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(SOCKET_ROOT, "dim-")));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  return { dir, home, tmp, socket: join(dir, "s") };
}

export function closeTurn(turn: Turn): void {
  rmSync(turn.dir, { recursive: true, force: true });
}

export type Listening = { stop(): void };

export function listen(socket: string, serve: (line: string) => string | null): Listening {
  const server = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(client) {
        client.data = { buffer: "" };
      },
      data(client, chunk) {
        client.data.buffer += chunk.toString();
        const end = client.data.buffer.indexOf("\n");
        if (end === -1) return;
        const reply = serve(client.data.buffer.slice(0, end));
        if (reply !== null) client.write(`${reply}\n`);
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

export type FileGuard = { readonly path: string; readonly putBack: () => boolean };

export function guardFile(path: string): FileGuard {
  const held = readFileSync(path);
  return {
    path,
    putBack: () => {
      if (readFileSync(path).equals(held)) return false;
      writeFileSync(path, held);
      return true;
    },
  };
}

const copyOf = (sessions: string, session: string) => join(sessions, `${session}.jsonl`);

export function copySession(transcript: string, sessions: string, session: string): void {
  mkdirSync(sessions, { recursive: true });
  copyFileSync(transcript, copyOf(sessions, session));
}

export function sessionWritten(transcript: string): boolean {
  return existsSync(transcript);
}

export function sessionHeld(sessions: string, session: string): boolean {
  return existsSync(copyOf(sessions, session));
}

export function restoreSession(sessions: string, session: string, transcript: string): void {
  if (existsSync(transcript)) return;
  invariant(sessionHeld(sessions, session), `the factory holds the copy of session ${session} it recorded`);
  mkdirSync(dirname(transcript), { recursive: true });
  copyFileSync(copyOf(sessions, session), transcript);
}

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
import { Glob } from "bun";
import { invariant } from "./assert";
import type { Turn } from "./station";
import type { Trace } from "./trace-contract";

const SOCKET_ROOT = "/tmp";

export function openTurn(trace: Trace, home: string): Turn {
  return trace.step(
    "turn_open",
    { home },
    () => {
      mkdirSync(home, { recursive: true });
      const dir = realpathSync(mkdtempSync(join(SOCKET_ROOT, "dim-")));
      const tmp = join(dir, "tmp");
      mkdirSync(tmp);
      return { dir, home, tmp, socket: join(dir, "s") };
    },
    (turn) => ({ dir: turn.dir }),
  );
}

export function closeTurn(trace: Trace, turn: Turn): void {
  trace.step("turn_close", { dir: turn.dir }, () => rmSync(turn.dir, { recursive: true, force: true }));
}

type Listening = { stop(): void };

type Writing = { unsent: Buffer; endWhenSent: boolean };

function flush(socket: { write(data: Buffer): number; end(): void }, writing: Writing): void {
  while (writing.unsent.length > 0) {
    const wrote = socket.write(writing.unsent);
    if (wrote <= 0) return;
    writing.unsent = writing.unsent.subarray(wrote);
  }
  if (writing.endWhenSent) socket.end();
}

export function listen(socket: string, serve: (line: string) => string): Listening {
  const server = Bun.listen<{ buffer: string; writing: Writing | null }>({
    unix: socket,
    socket: {
      open(client) {
        client.data = { buffer: "", writing: null };
      },
      data(client, chunk) {
        if (client.data.writing !== null) return;
        client.data.buffer += chunk.toString();
        const end = client.data.buffer.indexOf("\n");
        if (end === -1) return;
        const reply = Buffer.from(`${serve(client.data.buffer.slice(0, end))}\n`);
        client.data.writing = { unsent: reply, endWhenSent: true };
        flush(client, client.data.writing);
      },
      drain(client) {
        if (client.data.writing !== null) flush(client, client.data.writing);
      },
    },
  });
  return { stop: () => server.stop(true) };
}

export function send(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const writing: Writing = { unsent: Buffer.from(`${line}\n`), endWhenSent: false };
    Bun.connect({
      unix: socket,
      socket: {
        open(server) {
          flush(server, writing);
        },
        drain(server) {
          flush(server, writing);
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

export function guardFile(trace: Trace, path: string): FileGuard {
  const held = readFileSync(path);
  return {
    path,
    putBack: () =>
      trace.step(
        "config_check",
        { path },
        () => {
          if (readFileSync(path).equals(held)) return false;
          writeFileSync(path, held);
          return true;
        },
        (restored) => ({ restored }),
      ),
  };
}

const copyOf = (sessions: string, session: string) => join(sessions, `${session}.jsonl`);

const SUBAGENT_FILES = new Glob("agent-*.{jsonl,meta.json}");

export function copySession(
  trace: Trace,
  transcript: string,
  subagents: string,
  sessions: string,
  session: string,
): void {
  trace.step("session_copy", { session }, () => {
    mkdirSync(sessions, { recursive: true });
    copyFileSync(transcript, copyOf(sessions, session));
    if (!existsSync(subagents)) return;
    const copied = join(sessions, session, "subagents");
    for (const name of SUBAGENT_FILES.scanSync({ cwd: subagents })) {
      mkdirSync(copied, { recursive: true });
      copyFileSync(join(subagents, name), join(copied, name));
    }
  });
}

export function sessionWritten(transcript: string): boolean {
  return existsSync(transcript);
}

export function sessionHeld(sessions: string, session: string): boolean {
  return existsSync(copyOf(sessions, session));
}

export function restoreSession(trace: Trace, sessions: string, session: string, transcript: string): void {
  if (existsSync(transcript)) return;
  invariant(sessionHeld(sessions, session), `the factory holds the copy of session ${session} it recorded`);
  trace.step("session_restore", { session }, () => {
    mkdirSync(dirname(transcript), { recursive: true });
    copyFileSync(copyOf(sessions, session), transcript);
  });
}

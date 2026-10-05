import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { SCHEMA_VERSION } from "./db-schema";

const WRITER = join(import.meta.dir, "db-writer.test-support.ts");
const HOLD_MS = 500;

const roots: string[] = [];
const children: Writer[] = [];

afterEach(() => {
  while (children.length > 0) children.pop()?.proc.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchPath(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-db-"));
  roots.push(root);
  return join(root, "sessions.db");
}

interface Writer {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  expectLine(line: string): Promise<void>;
  send(): void;
}

function spawnWriter(
  mode: "hold" | "write" | "read-write" | "open" | "initialize",
  path: string,
  who: string,
): Writer {
  const proc = Bun.spawn(["bun", WRITER, mode, path, who], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const writer: Writer = {
    proc,
    async expectLine(line) {
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error(`${who} exited before printing ${line}: ${await new Response(proc.stderr).text()}`);
        buffered += value;
      }
      const end = buffered.indexOf("\n");
      expect(buffered.slice(0, end)).toBe(line);
      buffered = buffered.slice(end + 1);
    },
    send() {
      proc.stdin.write("go\n");
      proc.stdin.flush();
    },
  };
  children.push(writer);
  return writer;
}

async function exited(writer: Writer): Promise<{ code: number; stderr: string }> {
  const code = await writer.proc.exited;
  return { code, stderr: await new Response(writer.proc.stderr).text() };
}

function committed(path: string): string[] {
  const reader = new Database(path, { readonly: true });
  try {
    return reader
      .query<{ who: string }, []>("SELECT who FROM probe ORDER BY who")
      .all()
      .map((row) => row.who);
  } finally {
    reader.close();
  }
}

describe("concurrent writers", () => {
  test("two first opens both succeed and stamp the version", async () => {
    const path = scratchPath();
    const empty = new Database(path, { create: true });
    empty.run("PRAGMA journal_mode = WAL");
    empty.close();
    const first = spawnWriter("initialize", path, "first");
    const second = spawnWriter("initialize", path, "second");
    await Promise.all([first.expectLine("ready"), second.expectLine("ready")]);
    first.send();
    second.send();

    expect(await exited(first)).toEqual({ code: 0, stderr: "" });
    expect(await exited(second)).toEqual({ code: 0, stderr: "" });
    const initialized = new Database(path, { readonly: true });
    expect(initialized.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    initialized.close();
  });

  test("a first open can retry after initialization times out on the write lock", () => {
    const path = scratchPath();
    const holder = new Database(path, { create: true });
    holder.run("PRAGMA journal_mode = WAL");
    holder.run("BEGIN IMMEDIATE");
    try {
      expect(() => openDb(path, { busyTimeoutMs: 50 })).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
    const reopened = openDb(path);
    expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    closeDb(reopened);
  });

  test("a writer opening while another holds the write lock waits for it and both commit", async () => {
    const path = scratchPath();
    const setup = openDb(path);
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    closeDb(setup);

    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    const opener = spawnWriter("open", path, "opener");
    await opener.expectLine("opening");
    await Bun.sleep(HOLD_MS);
    holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(opener)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "opener"]);
  }, 20_000);

  test("a writer already open waits for another's write lock and both commit", async () => {
    const path = scratchPath();
    const setup = openDb(path);
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    closeDb(setup);

    const writer = spawnWriter("write", path, "writer");
    await writer.expectLine("opened");
    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    writer.send();
    await writer.expectLine("writing");
    await Bun.sleep(HOLD_MS);
    holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(writer)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "writer"]);
  }, 20_000);

  test("a transaction that reads before it writes waits for another's write lock and both commit", async () => {
    const path = scratchPath();
    const setup = openDb(path);
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    closeDb(setup);

    const writer = spawnWriter("read-write", path, "writer");
    await writer.expectLine("opened");
    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    writer.send();
    await writer.expectLine("writing");
    await Bun.sleep(HOLD_MS);
    holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(writer)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "writer"]);
  }, 20_000);

  test("a lock held past the wait fails the writer with SQLITE_BUSY", () => {
    const path = scratchPath();
    const setup = openDb(path);
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    closeDb(setup);

    const holder = new Database(path);
    holder.run("BEGIN IMMEDIATE");
    const writer = openDb(path, { busyTimeoutMs: 50 });
    try {
      expect(writer.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 50 });
      let caught: unknown;
      try {
        writer.run("INSERT INTO probe (who) VALUES ('writer')");
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      writer.close();
      holder.run("ROLLBACK");
      holder.close();
    }
  });
});

describe("the lock wait a connection is opened with", () => {
  test("defaults to five seconds", () => {
    const conn = openDb(scratchPath());
    try {
      expect(conn.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      conn.close();
    }
  });
});

describe("a record of another version", () => {
  for (const found of [0, 1, SCHEMA_VERSION + 1]) {
    test(`is refused at version ${found} and left unchanged`, () => {
      const path = scratchPath();
      const old = new Database(path, { create: true });
      old.run("CREATE TABLE legacy (value TEXT)");
      old.run(`PRAGMA user_version = ${found}`);
      old.close();

      expect(() => openDb(path)).toThrow(
        expect.objectContaining({ code: "record_version", meta: { found, expected: SCHEMA_VERSION } }),
      );

      const after = new Database(path, { readonly: true });
      expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "legacy" },
      ]);
      expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: found });
      after.close();
    });
  }
});

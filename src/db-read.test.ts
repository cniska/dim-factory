import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb, SchemaTooOldError } from "./db";
import { NoDatabaseError, openReadOnly } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import { queueOrder } from "./order-lifecycle";
import { dbPath } from "./paths";
import { qCommand } from "./q-command";
import { QUERIES } from "./query-registry";
import { sqlCommand } from "./sql-command";
import { runTraceCommand } from "./trace-command";
import { wallHandler } from "./wall/server";
import { mintWorker } from "./worker";

function writtenDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dim-db-read-")), "sessions.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE note (body TEXT)");
  db.run("INSERT INTO note VALUES ('kept')");
  db.close();
  return path;
}

describe("opening the database to read", () => {
  test("reads a WAL database whose -wal and -shm files are gone", () => {
    const path = writtenDatabase();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });

    const db = openReadOnly(path);
    try {
      expect(db.query("SELECT body FROM note").all()).toEqual([{ body: "kept" }]);
    } finally {
      db.close();
    }
  });

  test("refuses a write", () => {
    const db = openReadOnly(writtenDatabase());
    try {
      expect(() => db.run("INSERT INTO note VALUES ('changed')")).toThrow(
        expect.objectContaining({ code: "SQLITE_READONLY" }),
      );
    } finally {
      db.close();
    }
  });

  test("names a missing database without creating one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dim-db-read-")), "sessions.db");

    expect(() => openReadOnly(path)).toThrow(NoDatabaseError);
    expect(existsSync(path)).toBe(false);
  });
});

const WRITES = [
  "INSERT INTO schema_version (version) VALUES (0)",
  "UPDATE schema_version SET version = 0",
  "DELETE FROM factory_order",
  "CREATE TABLE note (body TEXT)",
  "DROP TABLE factory_order_event",
  "PRAGMA user_version = 7",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
];

function recordWithOrder(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-db-read-"));
  const path = dbPath({ DIM_HOME: home });
  const db = openDb(path);
  const operator = mintWorker(db, { role: "operator", pid: process.ppid, sessionId: "reader-test" });
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Stay as written" }, operator.name);
  closeDb(db);
  return { home, path };
}

function fingerprint(path: string): string {
  const db = new Database(path);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function recordBesideTraces(path: string): unknown {
  const db = new Database(path);
  try {
    const tables = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name <> 'trace_event' ORDER BY name",
      )
      .all();
    return {
      userVersion: db.query("PRAGMA user_version").get(),
      tables: tables.map(({ name, sql }) => ({ sql, rows: db.query(`SELECT * FROM "${name}"`).all() })),
    };
  } finally {
    db.close();
  }
}

async function asDimHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.DIM_HOME;
  process.env.DIM_HOME = home;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.DIM_HOME;
    else process.env.DIM_HOME = before;
  }
}

describe("each reader of the record", () => {
  test("dim sql fails on every write and leaves the database as it was", async () => {
    const { home, path } = recordWithOrder();
    try {
      const before = fingerprint(path);
      for (const statement of WRITES) {
        const refused = await asDimHome(home, async () => {
          try {
            await sqlCommand.run([statement]);
            return null;
          } catch (error) {
            return (error as { code?: string }).code;
          }
        });
        expect({ statement, refused }).toEqual({ statement, refused: "SQLITE_READONLY" });
        expect(fingerprint(path)).toBe(before);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dim q answers every query without changing the record beside its own trace, and creates none", async () => {
    const { home, path } = recordWithOrder();
    const empty = mkdtempSync(join(tmpdir(), "dim-db-read-"));
    try {
      const before = recordBesideTraces(path);
      for (const query of QUERIES) {
        const args = query.name === "factory" ? [query.name] : [query.name, "order-1"];
        await asDimHome(home, () => qCommand.run(args));
      }
      expect(recordBesideTraces(path)).toEqual(before);

      await expect(asDimHome(empty, () => qCommand.run(["order", "order-1"]))).rejects.toBeInstanceOf(
        NoDatabaseError,
      );
      expect(existsSync(dbPath({ DIM_HOME: empty }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the wall serves the board and an order without changing the database, and creates none", async () => {
    const { home, path } = recordWithOrder();
    const empty = mkdtempSync(join(tmpdir(), "dim-db-read-"));
    const answer = (wall: ReturnType<typeof wallHandler>, route: string): Response => {
      const response = wall.fetch(new Request(`http://127.0.0.1${route}`), { upgrade: () => false });
      if (!response) throw new Error(`${route} was answered with an upgrade`);
      return response;
    };
    try {
      const before = fingerprint(path);
      const wall = wallHandler(path);
      const board = answer(wall, "/api/snapshot");
      expect(board.status).toBe(200);
      expect(((await board.json()) as { orders: unknown[] }).orders).toHaveLength(1);
      expect(answer(wall, "/api/order/order-1").status).toBe(200);
      expect(fingerprint(path)).toBe(before);

      const missing = dbPath({ DIM_HOME: empty });
      expect(answer(wallHandler(missing), "/api/snapshot")?.status).toBe(503);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function stampSchemaVersion(path: string, version: number): void {
  const db = new Database(path);
  db.run("UPDATE schema_version SET version = ?", [version]);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

async function refusal(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("a reader of a record built by another schema version", () => {
  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    test(`refuses version ${version > SCHEMA_VERSION ? "newer" : "older"} than this one before any query, leaving it as it was`, async () => {
      const { home, path } = recordWithOrder();
      try {
        stampSchemaVersion(path, version);
        const before = fingerprint(path);
        const readers: Record<string, () => unknown> = {
          "dim q": () => qCommand.run(["order", "order-1"]),
          "dim sql": () => sqlCommand.run(["SELECT 1"]),
          "dim trace": () => runTraceCommand("order-1", { DIM_HOME: home }, () => {}),
        };
        for (const [reader, run] of Object.entries(readers)) {
          const error = await asDimHome(home, () => refusal(run));
          expect({ reader, error }).toEqual({ reader, error: expect.any(SchemaTooOldError) });
          expect({ reader, code: (error as SchemaTooOldError).code }).toEqual({
            reader,
            code: "SCHEMA_TOO_OLD",
          });
        }
        const wall = wallHandler(path);
        for (const route of ["/api/snapshot", "/api/order/order-1"]) {
          const response = wall.fetch(new Request(`http://127.0.0.1${route}`), { upgrade: () => false });
          expect({ route, status: response?.status }).toEqual({ route, status: 503 });
          expect(await response?.json()).toEqual({ error: new SchemaTooOldError(version).message });
        }
        expect(fingerprint(path)).toBe(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("dim sql creates no database where there is none", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dim-db-read-"));
    try {
      expect(await asDimHome(empty, () => refusal(() => sqlCommand.run(["SELECT 1"])))).toBeInstanceOf(
        NoDatabaseError,
      );
      expect(existsSync(dbPath({ DIM_HOME: empty }))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

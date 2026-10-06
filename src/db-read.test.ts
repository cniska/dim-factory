import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { openReadOnly } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import { errorCode } from "./error-code";
import { dbPath } from "./paths";
import { queryCommand } from "./query-command";
import { QUERIES } from "./query-registry";
import { sqlCommand } from "./sql-command";
import { traceCommand } from "./trace-command";
import { wallHandler } from "./wall/server";

function writtenDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dim-db-read-")), "sessions.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE note (body TEXT)");
  db.run("INSERT INTO note VALUES ('kept')");
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

    expect(() => openReadOnly(path)).toThrow(expect.objectContaining({ code: "no_database" }));
    expect(existsSync(path)).toBe(false);
  });
});

const WRITES = [
  "INSERT INTO repo_commit (sha, repo, label, ts, subject) VALUES ('def456', '/repo', 'x', '2026-01-01T00:00:00Z', 'x')",
  "UPDATE repo_commit SET subject = 'changed'",
  "DELETE FROM repo_commit",
  "CREATE TABLE note (body TEXT)",
  "DROP TABLE hook_event",
  "PRAGMA user_version = 7",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
];

function recordWithCommit(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-db-read-"));
  const path = dbPath({ XDG_DATA_HOME: home });
  const db = openDb(path);
  db.run(
    "INSERT INTO repo_commit (sha, repo, label, ts, subject) VALUES ('abc123', '/repo', 'cniska/dim-factory', '2026-01-01T00:00:00Z', 'feat: stay as written')",
  );
  db.close();
  return { home, path };
}

function fingerprint(path: string): string {
  const db = new Database(path);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function recordOf(path: string): unknown {
  const db = new Database(path);
  try {
    const tables = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
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

async function asDataHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = before;
  }
}

describe("each reader of the record", () => {
  test("dim sql fails on every write and leaves the database as it was", async () => {
    const { home, path } = recordWithCommit();
    try {
      const before = fingerprint(path);
      for (const statement of WRITES) {
        const refused = await asDataHome(home, async () => {
          try {
            await sqlCommand.run([statement]);
            return null;
          } catch (error) {
            return errorCode(error);
          }
        });
        expect({ statement, refused }).toEqual({ statement, refused: "SQLITE_READONLY" });
        expect(fingerprint(path)).toBe(before);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dim sql reads one row past the cap and no further", async () => {
    const { home } = recordWithCommit();
    try {
      const failsAtRow50 = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
        SELECT CASE WHEN i = 50 THEN abs(-9223372036854775808) ELSE i END AS i FROM n`;
      const result = await asDataHome(home, () => sqlCommand.run([failsAtRow50]));
      expect(result).toMatchObject({
        denominator: "more than 40 rows",
        more: "more rows than 40; --rows <n> to widen",
      });
      expect(result).toHaveProperty("rows.length", 40);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dim query answers every query without changing the record, and creates none", async () => {
    const { home, path } = recordWithCommit();
    const empty = mkdtempSync(join(tmpdir(), "dim-db-read-"));
    try {
      const before = recordOf(path);
      for (const query of QUERIES) await asDataHome(home, () => queryCommand.run([query.name, "stay"]));
      expect(recordOf(path)).toEqual(before);

      await expect(asDataHome(empty, () => queryCommand.run(["search", "stay"]))).rejects.toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath({ XDG_DATA_HOME: empty }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function stampSchemaVersion(path: string, version: number): void {
  const db = new Database(path);
  db.run(`PRAGMA user_version = ${version}`);
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
      const { home, path } = recordWithCommit();
      try {
        stampSchemaVersion(path, version);
        const before = fingerprint(path);
        const readers: Record<string, () => unknown> = {
          "dim query": () => queryCommand.run(["search", "stay"]),
          "dim sql": () => sqlCommand.run(["SELECT 1"]),
          "dim trace": () => traceCommand.run(["k7m2qx4d"]),
        };
        for (const [reader, run] of Object.entries(readers)) {
          const error = await asDataHome(home, () => refusal(run));
          expect({ reader, error }).toEqual({
            reader,
            error: expect.objectContaining({ code: "record_version" }),
          });
        }
        const sent: string[] = [];
        wallHandler(path).websocket.open({ data: { order: null }, send: (push) => sent.push(String(push)) });
        expect(sent.map((push) => JSON.parse(push))).toMatchObject([
          { kind: "failure", failure: { code: "record_version" } },
        ]);
        expect(fingerprint(path)).toBe(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("dim sql creates no database where there is none", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dim-db-read-"));
    try {
      expect(await asDataHome(empty, () => refusal(() => sqlCommand.run(["SELECT 1"])))).toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath({ XDG_DATA_HOME: empty }))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

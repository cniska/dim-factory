import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mintWorker } from "./factory-worker";
import { SCHEMA_SQL } from "./schema";
import { acceptWorker, inviteWorker } from "./worker-invitation";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

describe("worker invitations", () => {
  test("creates a child only when its harness session accepts", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const invitation = inviteWorker(db, { parentWorker: parent.name, role: "planner" });

    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    const child = acceptWorker(db, {
      id: invitation.id,
      token: invitation.token,
      sessionId: "planner-session",
    });

    expect(db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(child.name)).toEqual(
      {
        role: "planner",
        parent_worker: parent.name,
      },
    );
    expect(
      db.query("SELECT accepted_worker FROM factory_worker_invitation WHERE id = ?").get(invitation.id),
    ).toEqual({
      accepted_worker: child.name,
    });
    db.close();
  });

  test("uses an invitation once", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const invitation = inviteWorker(db, { parentWorker: parent.name, role: "builder" });
    acceptWorker(db, { id: invitation.id, token: invitation.token, sessionId: "builder-session" });

    expect(() =>
      acceptWorker(db, { id: invitation.id, token: invitation.token, sessionId: "other-session" }),
    ).toThrow(expect.objectContaining({ code: "invitation_used" }));
    db.close();
  });

  test("does not let a child choose another invitation's token", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const invitation = inviteWorker(db, { parentWorker: parent.name, role: "reviewer" });

    expect(() =>
      acceptWorker(db, { id: invitation.id, token: "wrong", sessionId: "reviewer-session" }),
    ).toThrow(expect.objectContaining({ code: "invitation_token" }));
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });
});

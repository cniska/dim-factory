import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type MintedWorker,
  mintWorker,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import type { Env } from "./paths";
import type { Role } from "./roles";

export const INVITATION_ID_VAR = "DIM_WORKER_INVITATION_ID";
export const INVITATION_TOKEN_VAR = "DIM_WORKER_INVITATION_TOKEN";

export class WorkerInvitationError extends Error {
  constructor(readonly code: "invitation_missing" | "invitation_used" | "invitation_token") {
    super(code);
  }
}

export type WorkerInvitation = {
  id: string;
  token: string;
  parentWorker: string;
  role: Role;
  createdAt: string;
};

export function invitationProcessEnv(
  machine: Env | undefined,
  invitation: Pick<WorkerInvitation, "id" | "token">,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries({ ...process.env, ...machine }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          WORKER_NAME_VAR,
          WORKER_TOKEN_VAR,
          WORKER_SESSION_VAR,
          INVITATION_ID_VAR,
          INVITATION_TOKEN_VAR,
        ].includes(entry[0]),
    ),
  );
  return {
    ...inherited,
    [INVITATION_ID_VAR]: invitation.id,
    [INVITATION_TOKEN_VAR]: invitation.token,
  };
}

const now = (): string => new Date().toISOString();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteWorker(
  db: Database,
  invitation: { parentWorker: string; role: Role },
  at = now(),
): WorkerInvitation {
  const id = `invite-${randomBytes(12).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  db.run(
    `INSERT INTO factory_worker_invitation
       (id, parent_worker, role, token_digest, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, invitation.parentWorker, invitation.role, digest(token), at],
  );
  return { id, token, parentWorker: invitation.parentWorker, role: invitation.role, createdAt: at };
}

export function acceptWorker(
  db: Database,
  invitation: { id: string; token: string; sessionId: string; pid?: number },
  at = now(),
): MintedWorker {
  if (!invitation.token) throw new WorkerInvitationError("invitation_token");
  return db.transaction(() => {
    const row = db
      .query<
        { parent_worker: string; role: Role; token_digest: string; accepted_at: string | null },
        [string]
      >(
        `SELECT parent_worker, role, token_digest, accepted_at
         FROM factory_worker_invitation WHERE id = ?`,
      )
      .get(invitation.id);
    if (!row) throw new WorkerInvitationError("invitation_missing");
    if (row.accepted_at !== null) throw new WorkerInvitationError("invitation_used");
    if (row.token_digest !== digest(invitation.token)) throw new WorkerInvitationError("invitation_token");

    const minted = mintWorker(
      db,
      {
        role: row.role,
        parentWorker: row.parent_worker,
        sessionId: invitation.sessionId,
        pid: invitation.pid,
      },
      at,
    );
    db.run(
      `UPDATE factory_worker_invitation
       SET accepted_at = ?, accepted_worker = ?
       WHERE id = ? AND accepted_at IS NULL`,
      [at, minted.name, invitation.id],
    );
    return minted;
  })();
}

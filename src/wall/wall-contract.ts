import type { RefusalRecord } from "../coded-error";
import type { Action, Next, Station, Status } from "../order-contract";
import type { Role } from "../worker-contract";

export type BoardStatus = Exclude<Status, "cancelled">;

export type WallWorker = { name: string; role: Role };

export type WallOrder = {
  id: string;
  title: string;
  project: string;
  description: string;
  station: Station | null;
  worker: WallWorker | null;
  status: Status;
  lastEventAt: string;
  next: Next | null;
};

export type BoardOrder = WallOrder & { status: BoardStatus };

export type WallSnapshot = {
  orders: BoardOrder[];
  totals: Record<BoardStatus, number>;
};

export type WallItemEntry = {
  at: string;
  action: Action;
  code: string | null;
  station: Station | null;
  worker: WallWorker | null;
};

export type WallArtifact = {
  revision: number;
  body: string;
  worker: WallWorker;
  approved: boolean;
};

export type WallItemView = {
  order: WallOrder;
  plan: WallArtifact | null;
  build: WallArtifact | null;
  review: WallArtifact | null;
  entries: WallItemEntry[];
};

export type BoardPush =
  | { kind: "snapshot"; snapshot: WallSnapshot }
  | { kind: "failure"; failure: RefusalRecord };

export type OrderPush = { kind: "order"; view: WallItemView } | { kind: "failure"; failure: RefusalRecord };

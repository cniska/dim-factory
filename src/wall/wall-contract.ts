export type Station = "plan" | "build" | "review";

export type Role = "operator" | "planner" | "builder" | "reviewer";

export type OrderLine = "feat" | "fix";

export type BoardStatus = "queued" | "running" | "shipped";

export type Next = "run" | "approve" | "revise" | "decide";

export type OrderEventKind =
  | "queued"
  | "started"
  | "station_started"
  | "artifact_submitted"
  | "artifact_approved"
  | "artifact_returned"
  | "commit_created"
  | "finding_raised"
  | "finding_answered"
  | "ship_retried"
  | "dropped"
  | "failed";

export type WallWorker = { name: string; role: Role };

export type WallOrder = {
  id: string;
  title: string;
  line: OrderLine;
  description: string | null;
  station: Station | null;
  worker: WallWorker | null;
  status: BoardStatus;
  lastEventAt: string;
  next: Next | null;
};

export type WallSnapshot = {
  orders: WallOrder[];
  totals: Record<BoardStatus, number>;
};

export type WallItemEntry = {
  at: string;
  kind: OrderEventKind;
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
  project: string;
  plan: WallArtifact | null;
  build: WallArtifact | null;
  review: WallArtifact | null;
  entries: WallItemEntry[];
};

export type WallFailure = { error: string };

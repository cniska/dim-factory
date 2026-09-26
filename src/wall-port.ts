import type { Env } from "./paths";

export const DEFAULT_WALL_PORT = 7326;

export const WALL_PORT_ENV = "DIM_WALL_PORT";

export const WALL_HOT_ENV = "DIM_WALL_HOT";

export class WallPortError extends Error {
  constructor(
    readonly kind: "not-a-port" | "in-use",
    message: string,
  ) {
    super(message);
    this.name = "WallPortError";
  }
}

export function wallPort(env: Env = process.env): number {
  const given = env[WALL_PORT_ENV];
  if (given === undefined || given.trim().length === 0) return DEFAULT_WALL_PORT;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new WallPortError("not-a-port", `${WALL_PORT_ENV} is ${given}, which is not a port`);
  }
  return port;
}

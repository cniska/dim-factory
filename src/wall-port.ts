import type { Env } from "./paths";

/**
 * One address, so a wall can be bookmarked and a link to it still works after
 * the server is restarted to pick up a change. Chosen from the user range and
 * away from the ports a dev server usually takes.
 */
export const DEFAULT_WALL_PORT = 7326;

export const WALL_PORT_ENV = "DIM_WALL_PORT";

/** Set on the run that is already under `bun --hot`, so it does not spawn a third. */
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

/**
 * A value that is not a port refuses rather than resolving to the default: the
 * variable is set to reach a particular address, and quietly serving somewhere
 * else is how a reader ends up watching a board nobody is writing to. 0 is kept
 * as the way to ask for any free port, which is what the tests serve on.
 */
export function wallPort(env: Env = process.env): number {
  const given = env[WALL_PORT_ENV];
  if (given === undefined || given.trim().length === 0) return DEFAULT_WALL_PORT;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new WallPortError("not-a-port", `${WALL_PORT_ENV} is ${given}, which is not a port`);
  }
  return port;
}

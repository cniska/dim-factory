import { refuser } from "../coded-error";
import type { Env } from "../paths";

export const DEFAULT_WALL_PORT = 7326;

export const WALL_PORT_ENV = "DIM_WALL_PORT";

export const WALL_SERVING_ENV = "DIM_WALL_SERVING";

export const refusePort = refuser<{
  readonly not_a_port: { readonly given: string };
  readonly port_in_use: { readonly port: number };
}>({
  not_a_port: {
    message: ({ given }) => `${WALL_PORT_ENV} is ${given}, which is not a port`,
    resolve: () => `unset ${WALL_PORT_ENV}, or set it to a port from 0 to 65535`,
  },
  port_in_use: {
    message: ({ port }) =>
      `something already listens on ${port}; it may be an older wall at http://127.0.0.1:${port}`,
    resolve: ({ port }) => `stop what listens on ${port} and run dim wall again, or set ${WALL_PORT_ENV}`,
  },
});

export function wallPort(env: Env = process.env): number {
  const given = env[WALL_PORT_ENV];
  if (given === undefined || given.trim().length === 0) return DEFAULT_WALL_PORT;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw refusePort("not_a_port", { given });
  return port;
}

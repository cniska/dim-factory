import { resolve } from "node:path";
import type { Command } from "./cli-contract";
import { dbPath } from "./paths";
import { DEFAULT_WALL_PORT, refusePort, WALL_PORT_ENV, WALL_SERVING_ENV, wallPort } from "./wall/port";
import { serveWall } from "./wall/server";

const BUNFIG = resolve(import.meta.dir, "..", "bunfig.toml");

export const wallCommand: Command = {
  name: "wall",
  usage: "usage: dim wall [--dev]",
  summary: `serve the local read-only factory wall on loopback, at one address every run (${DEFAULT_WALL_PORT}, or ${WALL_PORT_ENV}); --dev reloads the page and the server as you edit`,
  async run(args) {
    const dev = args.includes("--dev");
    if (process.env[WALL_SERVING_ENV] !== "1") {
      const hot = dev ? ["--hot"] : [];
      const child = Bun.spawn(
        ["bun", `--config=${BUNFIG}`, ...hot, process.argv[1] as string, "wall", ...args],
        {
          env: { ...process.env, [WALL_SERVING_ENV]: "1" },
          stdio: ["inherit", "inherit", "inherit"],
        },
      );
      process.exit(await child.exited);
    }
    const port = wallPort();
    const server = await serveWall({ port, path: dbPath(), hmr: dev }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw refusePort("port_in_use", { port });
      throw error;
    });
    return { url: `http://${server.hostname}:${server.port}` };
  },
};

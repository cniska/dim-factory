import type { Command } from "./cli-contract";
import { DEFAULT_WALL_PORT, WALL_HOT_ENV, WALL_PORT_ENV, WallPortError, wallPort } from "./wall-port";
import { serveWall } from "./wall-server";

export const wallCommand: Command = {
  name: "wall",
  usage: "usage: dim wall [--dev]",
  summary: `serve the local read-only factory wall on loopback, at one address every run (${DEFAULT_WALL_PORT}, or ${WALL_PORT_ENV}); --dev reloads the page and the server as you edit`,
  async run(args) {
    const dev = args.includes("--dev");
    if (dev && process.env[WALL_HOT_ENV] !== "1") {
      const child = Bun.spawn(["bun", "--hot", process.argv[1] as string, "wall", ...args], {
        env: { ...process.env, [WALL_HOT_ENV]: "1" },
        stdio: ["inherit", "inherit", "inherit"],
      });
      process.exit(await child.exited);
    }
    const port = wallPort();
    const server = await serveWall({ port, hmr: dev }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new WallPortError(
          "in-use",
          `something already listens on ${port}. It may be an older wall: open http://127.0.0.1:${port}, or stop it and run this again, or set ${WALL_PORT_ENV}`,
        );
      }
      throw error;
    });
    return { url: `http://${server.hostname}:${server.port}` };
  },
};

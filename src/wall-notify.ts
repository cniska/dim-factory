import { createSocket } from "node:dgram";
import { wallPort } from "./wall/port";

const LOOPBACK = "127.0.0.1";

export function notifyWall(recordPath: string): void {
  const socket = createSocket("udp4");
  socket.send(recordPath, wallPort(), LOOPBACK, (error) => {
    socket.close();
    if (error) throw error;
  });
}

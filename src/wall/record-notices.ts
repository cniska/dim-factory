import type { udp } from "bun";

export type Hearing = { readonly port: number; readonly stop: () => void };

type Listener = {
  readonly socket: udp.Socket<"buffer">;
  recordPath: string;
  changed: () => void;
};

declare global {
  var dimWallListener: Listener | undefined;
}

export async function hearRecordWrites(
  recordPath: string,
  port: number,
  changed: () => void,
): Promise<Hearing> {
  const kept = globalThis.dimWallListener;
  if (kept !== undefined && port !== 0 && kept.socket.port === port) {
    kept.recordPath = recordPath;
    kept.changed = changed;
    return hearingOf(kept);
  }
  let pending = false;
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, data) {
        if (pending || data.toString() !== listener.recordPath) return;
        pending = true;
        setImmediate(() => {
          pending = false;
          listener.changed();
        });
      },
    },
  });
  const listener: Listener = { socket, recordPath, changed };
  globalThis.dimWallListener = listener;
  return hearingOf(listener);
}

function hearingOf(listener: Listener): Hearing {
  return {
    port: listener.socket.port,
    stop: () => {
      listener.socket.close();
      if (globalThis.dimWallListener === listener) globalThis.dimWallListener = undefined;
    },
  };
}

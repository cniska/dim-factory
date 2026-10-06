export async function hearRecordWrites(
  recordPath: string,
  port: number,
  changed: () => void,
): Promise<() => void> {
  let pending = false;
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, data) {
        if (pending || data.toString() !== recordPath) return;
        pending = true;
        setImmediate(() => {
          pending = false;
          changed();
        });
      },
    },
  });
  return () => socket.close();
}

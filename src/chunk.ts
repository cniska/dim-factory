import { closeSync, openSync, readSync, statSync } from "node:fs";

export type Chunk = { lines: string[]; bytes: number };

/**
 * Read whole lines from `cursor` to end of file, and report how many bytes they
 * span. A live session can leave a half-written last line; advancing the cursor
 * past it would drop that line forever, so the partial tail is left unread.
 */
export function readChunk(path: string, cursor: number): Chunk {
  const size = statSync(path).size;
  if (size <= cursor) return { lines: [], bytes: 0 };

  const fd = openSync(path, "r");
  try {
    const length = size - cursor;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, cursor + read);
      if (n === 0) break;
      read += n;
    }
    if (read === 0) return { lines: [], bytes: 0 };

    const lastNewline = buf.lastIndexOf(0x0a, read - 1);
    if (lastNewline === -1) return { lines: [], bytes: 0 };

    const lines = buf
      .subarray(0, lastNewline + 1)
      .toString("utf8")
      .split("\n");
    lines.pop();
    return { lines, bytes: lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

export function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

export function readFrom(path: string, offset: number): Buffer {
  const size = sizeOf(path);
  if (size <= offset) return Buffer.alloc(0);
  const bytes = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, bytes, 0, bytes.length, offset);
  } finally {
    closeSync(fd);
  }
  return bytes;
}

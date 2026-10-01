import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

export function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

export function readFrom(path: string, offset: number): string {
  return existsSync(path) ? readFileSync(path).subarray(offset).toString() : "";
}

export function empty(path: string): void {
  if (existsSync(path)) writeFileSync(path, "");
}

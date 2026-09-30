import type { Env } from "./paths";

export const CHECK_OUTPUT_TAIL_BYTES = 64 * 1024;

const PASSED_THROUGH = ["PATH", "USER", "LANG"] as const;

const quoted = (path: string) => JSON.stringify(path);

export function sandboxProfile(writable: readonly string[]): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writable.map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
  ].join("\n");
}

export function checkEnv(owner: Env, tmp: string): Record<string, string> {
  const listed = Object.fromEntries(
    PASSED_THROUGH.flatMap((name) => {
      const value = owner[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { ...listed, HOME: tmp, TMPDIR: tmp, XDG_CACHE_HOME: `${tmp}/cache` };
}

export function outputTail(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= CHECK_OUTPUT_TAIL_BYTES) return output;
  return bytes.subarray(bytes.length - CHECK_OUTPUT_TAIL_BYTES).toString("utf8");
}

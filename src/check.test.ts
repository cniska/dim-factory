import { describe, expect, test } from "bun:test";
import { checkEnv, outputTail } from "./check";

describe("a check's environment", () => {
  test("holds none of the owner's keys or sign-in, and puts its home and caches in its temp directory", () => {
    const env = checkEnv(
      {
        PATH: "/bin",
        USER: "owner",
        ANTHROPIC_API_KEY: "sk-ant",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        HOME: "/owner",
      },
      "/tmp/dim-check-x",
    );
    expect(env).toEqual({
      PATH: "/bin",
      USER: "owner",
      HOME: "/tmp/dim-check-x",
      TMPDIR: "/tmp/dim-check-x",
      XDG_CACHE_HOME: "/tmp/dim-check-x/cache",
    });
  });
});

describe("a check's output", () => {
  test("keeps the end of an output longer than the cap, where a failure says what failed", () => {
    const long = `${"x".repeat(65536)}FAILED: the last line`;
    const kept = outputTail(long);
    expect(Buffer.byteLength(kept)).toBe(65536);
    expect(kept.endsWith("FAILED: the last line")).toBe(true);
    expect(outputTail("short")).toBe("short");
  });
});

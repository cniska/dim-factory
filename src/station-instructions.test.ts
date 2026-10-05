import { describe, expect, test } from "bun:test";
import { stationInstructions } from "./station-instructions";

const titles = (text: string) => [...text.matchAll(/^# (.+)$/gm)].flatMap((match) => match[1] ?? []);

const namedBelow = (text: string) =>
  [...text.matchAll(/\*([^*]+)\* below/g)].flatMap((match) => match[1] ?? []);

describe("station instructions", () => {
  test("open with the station's own instructions", () => {
    expect(titles(stationInstructions("plan"))[0]).toBe("Plan");
    expect(titles(stationInstructions("build"))[0]).toBe("Build");
    expect(titles(stationInstructions("review"))[0]).toBe("Review");
  });

  test("hold every reference the station's instructions name, and only those", () => {
    for (const station of ["plan", "build", "review"] as const) {
      const text = stationInstructions(station);
      expect(titles(text).slice(1).sort()).toEqual([...new Set(namedBelow(text))].sort());
    }
  });

  test("link no file, since a worker reads them in its system prompt", () => {
    for (const station of ["plan", "build", "review"] as const) {
      expect(stationInstructions(station)).not.toMatch(/\]\([^)]*\.md\)/);
    }
  });
});

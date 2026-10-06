import { describe, expect, test } from "bun:test";
import { stationInstructions } from "./station-instructions";

const STATIONS = ["plan", "build", "review"] as const;

const titles = (text: string) => [...text.matchAll(/^# (.+)$/gm)].flatMap((match) => match[1] ?? []);

const namedBelow = (text: string) =>
  [...text.matchAll(/\*([^*]+)\* below/g)].flatMap((match) => match[1] ?? []);

describe("station instructions", () => {
  test("open with the station's own instructions", () => {
    expect(titles(stationInstructions("plan", ["typescript"]))[0]).toBe("Plan");
    expect(titles(stationInstructions("build", ["typescript"]))[0]).toBe("Build");
    expect(titles(stationInstructions("review", ["typescript"]))[0]).toBe("Review");
  });

  test("hold every reference the station's instructions name, and only those", () => {
    for (const station of STATIONS) {
      const text = stationInstructions(station, []);
      expect(titles(text).slice(1).sort()).toEqual([...new Set(namedBelow(text))].sort());
    }
  });

  test("give the builder and the reviewer the guidance for each language the project uses, and the planner none", () => {
    const guided = (station: (typeof STATIONS)[number], languages: readonly "typescript"[]) =>
      stationInstructions(station, languages).includes("`null` is the empty value");
    expect(guided("build", ["typescript"])).toBe(true);
    expect(guided("review", ["typescript"])).toBe(true);
    expect(guided("plan", ["typescript"])).toBe(false);
    expect(guided("build", [])).toBe(false);
  });

  test("link no file, since a worker reads them in its system prompt", () => {
    for (const station of STATIONS) {
      expect(stationInstructions(station, ["typescript"])).not.toMatch(/\]\([^)]*\.md\)/);
    }
  });
});

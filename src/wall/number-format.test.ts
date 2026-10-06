import { expect, test } from "bun:test";
import { formatCompactNumber } from "./number-format";

test("reads a count on one ladder: whole below a thousand, one decimal below a hundred units, never four digits", () => {
  expect(formatCompactNumber(0)).toBe("0");
  expect(formatCompactNumber(999)).toBe("999");
  expect(formatCompactNumber(1000)).toBe("1.0k");
  expect(formatCompactNumber(12_345)).toBe("12.3k");
  expect(formatCompactNumber(310_400)).toBe("310k");
  expect(formatCompactNumber(999_500)).toBe("1.0M");
  expect(formatCompactNumber(1_240_000)).toBe("1.2M");
  expect(formatCompactNumber(148_000_000)).toBe("148M");
});

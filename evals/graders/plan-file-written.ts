import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Grader } from "../grader-contract";

const Plan = z.object({
  body: z.string().min(1),
  slices: z.array(z.object({ title: z.string(), outcome: z.string() })).min(1),
});

export const planFileWritten: Grader = {
  name: "plan-file-written",
  grade({ tmp }) {
    const path = join(tmp, "plan.json");
    if (!existsSync(path)) return { pass: false, reason: `no ${path}` };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return { pass: false, reason: `${path} does not parse: ${error}` };
    }
    const parsed = Plan.safeParse(raw);
    return parsed.success
      ? { pass: true, reason: "the plan file holds a body and slices" }
      : { pass: false, reason: z.prettifyError(parsed.error) };
  },
};

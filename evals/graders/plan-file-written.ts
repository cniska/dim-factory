import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import type { Grader } from "../grader-contract";

const Plan = z.object({
  body: z.string().min(1),
  slices: z.array(z.object({ title: z.string(), outcome: z.string() })).min(1),
});

export const planFileWritten: Grader = {
  name: "plan-file-written",
  grade({ tmp }) {
    const [found] = [...new Glob("**/plan.json").scanSync({ cwd: tmp, dot: true })];
    if (found === undefined) return { pass: false, reason: `no plan.json under ${tmp}` };
    const path = join(tmp, found);
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

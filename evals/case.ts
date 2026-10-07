import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Grader } from "./grader-contract";
import { GRADERS, type GraderName } from "./graders";

const isGraderName = (name: string): name is GraderName => Object.hasOwn(GRADERS, name);

const CaseFile = z.strictObject({
  instruction: z.string(),
  model: z.string(),
  runs: z.number().int().positive(),
  tools: z.string(),
  graders: z.array(z.string()).min(1),
});

export type Case = {
  readonly name: string;
  readonly dir: string;
  readonly instruction: string;
  readonly model: string;
  readonly runs: number;
  readonly tools: string;
  readonly prompt: string;
  readonly graders: readonly Grader[];
};

export function caseAt(casesDir: string, name: string): Case {
  const dir = join(casesDir, name);
  const file = CaseFile.parse(JSON.parse(readFileSync(join(dir, "case.json"), "utf8")));
  const graders = file.graders.map((grader) => {
    if (!isGraderName(grader)) throw new Error(`${name}/case.json names an unknown grader ${grader}`);
    return GRADERS[grader];
  });
  return {
    name,
    dir,
    instruction: file.instruction,
    model: file.model,
    runs: file.runs,
    tools: file.tools,
    prompt: readFileSync(join(dir, "prompt.md"), "utf8"),
    graders,
  };
}

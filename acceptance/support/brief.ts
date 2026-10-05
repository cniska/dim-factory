import { z } from "zod";

const Brief = z.looseObject({ order: z.looseObject({ id: z.string() }), workspace: z.string() });

type Brief = z.infer<typeof Brief>;

export function briefFrom(prompt: string): Brief {
  return Brief.parse(JSON.parse(prompt));
}

import { z } from "zod";

const Brief = z.looseObject({ skill: z.string() });

type Brief = z.infer<typeof Brief>;

export function briefOf(prompt: string): Brief | null {
  let json: unknown;
  try {
    json = JSON.parse(prompt);
  } catch {
    return null;
  }
  const brief = Brief.safeParse(json);
  return brief.success ? brief.data : null;
}

export function briefFrom(prompt: string): Brief {
  const brief = briefOf(prompt);
  if (brief === null) throw new Error(`the prompt is not a brief:\n${prompt}`);
  return brief;
}

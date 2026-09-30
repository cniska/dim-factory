export type Brief = { readonly skill: string; readonly [field: string]: unknown };

export function briefOf(prompt: string): Brief | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("skill" in parsed)) return null;
  return typeof parsed.skill === "string" ? (parsed as Brief) : null;
}

export function briefFrom(prompt: string): Brief {
  const brief = briefOf(prompt);
  if (brief === null) throw new Error(`the prompt is not a brief:\n${prompt}`);
  return brief;
}

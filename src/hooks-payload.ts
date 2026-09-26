export async function readHookPayload(): Promise<Record<string, unknown>> {
  if (Bun.stdin.stream().locked || process.stdin.isTTY) return {};
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

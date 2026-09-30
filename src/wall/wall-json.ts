import type { WallFailure } from "./wall-contract";

export async function wallJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error((body as WallFailure).error);
  return body as T;
}

import { z } from "zod";

export const HARNESSES = ["codex", "claude"] as const;
export const HarnessName = z.enum(HARNESSES);
export type HarnessName = z.infer<typeof HarnessName>;

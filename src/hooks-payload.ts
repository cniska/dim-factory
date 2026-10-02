import { z } from "zod";
import { refuser } from "./coded-error";

const refusePayload = refuser<{ readonly hook_payload_invalid: { readonly reason: string } }>({
  hook_payload_invalid: {
    message: ({ reason }) => `the hook payload on stdin is not one dim reads: ${reason}`,
    resolve: () => "run dim hooks start or edit from the installed hook, which pipes the harness's payload",
  },
});

export const StartPayload = z.object({ cwd: z.string() });

export const EditPayload = z.object({
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z
    .object({ file_path: z.unknown(), notebook_path: z.unknown(), command: z.unknown() })
    .partial(),
});
export type EditPayload = z.infer<typeof EditPayload>;

export async function readHookPayload<T>(schema: z.ZodType<T>): Promise<T> {
  const text = process.stdin.isTTY ? "" : await Bun.stdin.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw refusePayload("hook_payload_invalid", { reason: "not JSON" });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw refusePayload("hook_payload_invalid", { reason: z.prettifyError(parsed.error) });
  return parsed.data;
}

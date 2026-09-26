import type { Command } from "./cli-contract";
import { type EditPayload, formatAfterEdit } from "./format-edit";
import { readHookPayload } from "./hooks-payload";

export const formatEditCommand: Command = {
  name: "format-edit",
  usage: "usage: dim format-edit < <PostToolUse hook payload>",
  summary: "run the repo's declared format task on the checkout an edit touched, from the PostToolUse hook",
  raw: () => true,
  async run() {
    try {
      formatAfterEdit((await readHookPayload()) as EditPayload);
    } catch {}
  },
};

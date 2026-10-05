import { createHash } from "node:crypto";

type SkillBodyFields = { bodyChars: number; bodySha256: string; skillPath: string };

export type SkillLoadRow =
  | { messageId?: string; ts: string; model?: string; skillName: string; how: "model" | "user" | "read" }
  | ({ toolUseId: string } & SkillBodyFields)
  | ({ parentUuid: string; skillName: string } & SkillBodyFields);

const BODY_PREFIX = "Base directory for this skill:";
const COMMAND_NAME = /<command-name>\/?([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)<\/command-name>/i;
const SKILL_FILE = /(?:^|[\s"'/])skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/i;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseSkillBody(text: string): ({ name: string } & SkillBodyFields) | undefined {
  if (!text.startsWith(BODY_PREFIX)) return undefined;
  const newline = text.indexOf("\n");
  const path = text.slice(BODY_PREFIX.length, newline === -1 ? undefined : newline).trim();
  if (path.length === 0) return undefined;
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return undefined;
  const body = newline === -1 ? "" : text.slice(newline + 1).replace(/^\n+/, "");
  return { name, skillPath: path, bodyChars: body.length, bodySha256: sha256(body) };
}

export function skillFromCommand(text: string): string | undefined {
  return COMMAND_NAME.exec(text)?.[1];
}

export function skillFromFileRead(command: string): string | undefined {
  return SKILL_FILE.exec(command)?.[1];
}

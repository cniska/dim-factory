import { createHash } from "node:crypto";

export type SkillLoadRow = {
  messageId?: string;
  ts: string;
  model?: string;
  skillName: string;
  how: "model" | "user" | "read";
  bodyChars?: number;
  bodySha256?: string;
  skillPath?: string;
};

const BODY_PREFIX = "Base directory for this skill:";
/** `<command-message>x</command-message>\n<command-name>/x</command-name>` */
const COMMAND_NAME = /<command-name>\/?([a-z0-9][a-z0-9-]*)<\/command-name>/i;
/** The model opening a skill file itself — Codex's usual path. */
const SKILL_FILE = /(?:^|[\s"'/])skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/i;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Claude injects the body after a `Base directory for this skill: <path>` line.
 * The wrapper is stripped before hashing so the hash is of the skill's text and
 * can be compared against a file on disk or a blob in git.
 */
export function parseSkillBody(text: string): { name: string; path: string; body: string } | undefined {
  if (!text.startsWith(BODY_PREFIX)) return undefined;
  const newline = text.indexOf("\n");
  const path = text.slice(BODY_PREFIX.length, newline === -1 ? undefined : newline).trim();
  if (path.length === 0) return undefined;
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return undefined;
  return { name, path, body: newline === -1 ? "" : text.slice(newline + 1).replace(/^\n+/, "") };
}

/** A prompt the user typed as `/name`. */
export function skillFromCommand(text: string): string | undefined {
  return COMMAND_NAME.exec(text)?.[1];
}

/** A command that reads a SKILL.md, which is a load without an invocation. */
export function skillFromFileRead(command: string): string | undefined {
  return SKILL_FILE.exec(command)?.[1];
}

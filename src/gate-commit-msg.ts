import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Gate, GateInput } from "./gate-contract";
import { checkSubject, SUBJECT_LIMIT, type Violation } from "./gate-subject";
import { checkoutSlug } from "./git-remote";
import { git } from "./git-tree";

const PREFIX = "commit-msg: ";

const FIXUP = "fixup! ";

const MESSAGES: Record<Violation, (subject: string) => string> = {
  empty: () => "subject is empty.",
  body: () => "commit has a body. The subject is the whole message.",
  "not-conventional": () => "subject is not a Conventional Commit (type(scope): what changed).",
  "too-long": (subject) => `subject is ${subject.length} characters, over the ${SUBJECT_LIMIT} allowed.`,
  "not-ascii": () => "subject is not ASCII.",
};

function namedSubject(subject: string): string {
  return subject.startsWith(FIXUP) ? namedSubject(subject.slice(FIXUP.length)) : subject;
}

function merging(cwd: string): boolean {
  const path = git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).out;
  return path !== "" && existsSync(resolve(cwd, path));
}

function refusal({ args, cwd }: GateInput): readonly string[] {
  const [messageFile] = args;
  if (messageFile === undefined) return [];
  const path = resolve(cwd, messageFile);
  if (!existsSync(path) || merging(cwd)) return [];
  const [subject = "", ...rest] = readFileSync(path, "utf8").split("\n");
  const body = rest.filter((line) => !line.startsWith("#") && line.trim() !== "").join("\n");
  const judged = namedSubject(subject);
  const violation = checkSubject(judged, body);
  if (violation === null) return [];
  return [`${PREFIX}${MESSAGES[violation](judged)}`, `  got: ${subject}`];
}

export const commitMsgGate: Gate = { owner: ({ cwd }) => checkoutSlug(cwd), refusal };

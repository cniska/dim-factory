import { execFileSync } from "node:child_process";
import { checkSubject, type Violation } from "./commit-gate";

export type Offense = { sha: string; subject: string; violation: Violation };

const FORMAT = "%H%x00%s%x00%b%x01";

export function checkRange(range: string, cwd = process.cwd()): Offense[] {
  let log: string;
  try {
    log = execFileSync("git", ["log", "--no-merges", `--format=${FORMAT}`, range], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`cannot enumerate commits for ${range}`);
  }

  const offenses: Offense[] = [];
  for (const record of log.split("\x01")) {
    const [sha, subject, body] = record.replace(/^\n/, "").split("\x00");
    if (!sha || subject === undefined) continue;
    const violation = checkSubject(subject, body ?? "");
    if (violation) offenses.push({ sha, subject, violation });
  }
  return offenses;
}

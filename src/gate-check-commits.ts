import { fail, GATE_ERROR } from "./gate-contract";
import { checkSubject, type Violation } from "./gate-subject";
import { git } from "./git-tree";

type Offense = { readonly sha: string; readonly subject: string; readonly violation: Violation };

const FORMAT = "%H%x00%s%x00%b%x01";

export function checkRange(range: string, cwd: string): readonly Offense[] {
  const log = git(cwd, ["log", "--no-merges", `--format=${FORMAT}`, range]);
  if (!log.ok) throw fail(GATE_ERROR.commitsUnenumerable, { range, detail: log.err });
  return log.out.split("\x01").flatMap((record) => {
    const [sha, subject, body] = record.replace(/^\n/, "").split("\x00");
    if (sha === undefined || sha === "" || subject === undefined || body === undefined) return [];
    const violation = checkSubject(subject, body);
    return violation === null ? [] : [{ sha, subject, violation }];
  });
}

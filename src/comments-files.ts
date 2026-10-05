import { nulFields, ranRaw } from "./git";
import { refuseGit } from "./git-contract";

export function trackedFiles(root: string, paths: readonly string[]): string[] {
  return nulFields(
    ranRaw(root, ["--literal-pathspecs", "ls-files", "-z", "--", ...paths]),
    "git ls-files -z",
  );
}

export function outsideTheCode(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const command = "git check-attr --stdin --cached -z";
  const fields = nulFields(
    ranRaw(
      root,
      [
        "--literal-pathspecs",
        "check-attr",
        "--stdin",
        "--cached",
        "-z",
        "linguist-generated",
        "linguist-vendored",
      ],
      {
        stdin: paths.map((p) => `${p}\0`).join(""),
      },
    ),
    command,
  );
  if (fields.length % 3 !== 0) {
    throw refuseGit("git_output_malformed", { command, problem: `${fields.length} fields, not triples` });
  }
  const skipped = new Set<string>();
  for (let at = 0; at < fields.length; at += 3) {
    const path = fields[at];
    const value = fields[at + 2];
    if (path !== undefined && (value === "set" || value === "true")) skipped.add(path);
  }
  return skipped;
}

import { execFileSync } from "node:child_process";

export function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

export function nulFields(output: string, command: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error(`${command} printed a record that does not end in NUL`);
  return output.slice(0, -1).split("\0");
}

export function outsideTheCode(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const command = "git check-attr --stdin --cached -z";
  const fields = nulFields(
    git(
      root,
      ["check-attr", "--stdin", "--cached", "-z", "linguist-generated", "linguist-vendored"],
      paths.map((p) => `${p}\0`).join(""),
    ),
    command,
  );
  if (fields.length % 3 !== 0) throw new Error(`${command} printed ${fields.length} fields, not triples`);
  const skipped = new Set<string>();
  for (let at = 0; at < fields.length; at += 3) {
    const value = fields[at + 2];
    if (value === "set" || value === "true") skipped.add(fields[at] as string);
  }
  return skipped;
}

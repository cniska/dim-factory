/**
 * The git subcommands a shell command actually runs, in order. One Bash call
 * routinely runs several — `git add -A && git commit -m …` is one row in
 * `tool_call` and two operations — so this returns a list rather than a verdict.
 *
 * `tool_call.git_operation` is the tool's own metadata and covers push, branch
 * and PR only, on one of the two tools. This covers every git a session ran,
 * which is most of them, at the cost of reading a command line rather than
 * being told.
 */

/** Separators that end one command and start another; anything else is an argument. */
const SEGMENT = /&&|\|\||[;|\n]/;

/** Global flags that take a value, so the token after them is not the subcommand. */
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** `git`, `/usr/bin/git`, `"…/git"` — a path ending in git, and never `.git` in an argument. */
const GIT = /^(?:['"]?[^\s'"]*\/)?git['"]?$/;

function subcommandOf(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // A leading `sudo`, `time` or an env assignment still runs git after it.
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=|^(sudo|time|command|nice)$/.test(tokens[i] as string)) {
    i += 1;
  }
  if (i >= tokens.length || !GIT.test(tokens[i] as string)) return null;
  i += 1;

  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (VALUED.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    return /^[a-z][a-z0-9-]*$/.test(token) ? token : null;
  }
  return null;
}

export function gitSubcommands(command: string): string[] {
  const found: string[] = [];
  for (const segment of command.split(SEGMENT)) {
    const sub = subcommandOf(segment);
    if (sub) found.push(sub);
  }
  return found;
}

const SEGMENT = /&&|\|\||[;|\n]/;

const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const GIT = /^(?:['"]?[^\s'"]*\/)?git['"]?$/;

function subcommandOf(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (/^[A-Z_][A-Z0-9_]*=|^(sudo|time|command|nice)$/.test(tokens[i] ?? "")) {
    i += 1;
  }
  if (!GIT.test(tokens[i] ?? "")) return null;
  i += 1;

  for (let token = tokens[i]; token !== undefined; token = tokens[i]) {
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

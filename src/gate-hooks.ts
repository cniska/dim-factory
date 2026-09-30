import { existsSync, readFileSync } from "node:fs";
import { fail, GATE_ERROR, REFUSED_EXIT } from "./gate-contract";
import { foldAscii } from "./git-remote-slug";

const OWNERS_LINE = /^# dim-owners: ([^\r\n]+)$/m;

export function hookBody(owners: readonly string[]): string {
  return `#!/bin/sh
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
# dim-owners: ${JSON.stringify(owners.map(foldAscii))}
hook=$(basename "$0")
command -v dim >/dev/null 2>&1 || { echo "$hook: dim is not on PATH, so this is not judged." >&2; exit 0; }
dim gate "$0" "$@"
status=$?
[ "$status" -eq ${REFUSED_EXIT} ] && exit 1
[ "$status" -eq 0 ] || echo "$hook: dim gate exited $status, so this is not judged." >&2
exit 0
`;
}

function parsedOwners(line: string): readonly string[] | null {
  try {
    const owners: unknown = JSON.parse(line);
    return Array.isArray(owners) && owners.every((owner) => typeof owner === "string") ? owners : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function hookOwners(path: string): readonly string[] | null {
  if (!existsSync(path)) return null;
  const line = OWNERS_LINE.exec(readFileSync(path, "utf8"))?.[1];
  const owners = line === undefined ? null : parsedOwners(line);
  if (owners === null) throw fail(GATE_ERROR.unreadableOwners, { path });
  return owners;
}

export function ownersCover(owners: readonly string[], slug: string | null): boolean {
  return slug !== null && owners.includes(slug);
}

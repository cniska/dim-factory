import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Both the symlink and its target, because macOS resolves /tmp to /private/tmp
// and a session records whichever cwd it was started in. /var/folders holds a
// temp tree per user, and a session's is not always the one handed to this
// process.
const TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

// `resolve` normalizes the spelling and follows no symlink, so the temp
// directory's own target has to be asked for separately. TMPDIR can name a
// directory that is already gone, and this runs at import: a rule about paths
// may not stop every `dim` command from starting.
const OWN_TEMP = ((named: string) => {
  try {
    return [named, realpathSync(named)];
  } catch {
    return [named];
  }
})(resolve(tmpdir()));

/**
 * A git repository inside a temp directory is an experiment the OS will delete,
 * so its subjects describe changes to files no reader can open later. The one
 * definition of the rule, because the same path test written twice drifts.
 */
export function isScratchRepo(path: string): boolean {
  const target = resolve(path);
  return [...TEMP_ROOTS, ...OWN_TEMP].some((root) => target === root || target.startsWith(`${root}/`));
}

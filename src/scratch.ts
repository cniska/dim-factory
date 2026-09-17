import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Both the symlink and its target, because macOS resolves /tmp to /private/tmp
// and a session records whichever cwd it was started in.
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

/**
 * A git repository inside a temp directory is an experiment the OS will delete,
 * so its subjects describe changes to files no reader can open later. The one
 * definition of the rule, because the same path test written twice drifts.
 */
export function isScratchRepo(path: string): boolean {
  const target = resolve(path);
  return [...TEMP_ROOTS, resolve(tmpdir())].some((root) => target === root || target.startsWith(`${root}/`));
}

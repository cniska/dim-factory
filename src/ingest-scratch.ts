import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Env, workspacesDir } from "./paths";

const TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

const OWN_TEMP = ((named: string) => {
  try {
    return [named, realpathSync(named)];
  } catch {
    return [named];
  }
})(resolve(tmpdir()));

export function isScratchRepo(path: string): boolean {
  const target = resolve(path);
  return [...TEMP_ROOTS, ...OWN_TEMP].some((root) => target === root || target.startsWith(`${root}/`));
}

export function isFactoryWorkspace(path: string, env: Env = process.env): boolean {
  return resolve(path).startsWith(`${workspacesDir(env)}/`);
}

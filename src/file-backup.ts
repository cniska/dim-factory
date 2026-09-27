import { constants, copyFileSync, lstatSync } from "node:fs";

export function nextBackupPath(source: string): string {
  const base = `${source}.dim-backup`;
  let path = base;
  let number = 2;
  while (lstatSync(path, { throwIfNoEntry: false })) {
    path = `${base}-${number}`;
    number += 1;
  }
  return path;
}

export function copyBackup(source: string): string {
  const backup = nextBackupPath(source);
  copyFileSync(source, backup, constants.COPYFILE_EXCL);
  return backup;
}

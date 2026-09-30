export function descendants(pid: number): readonly number[] {
  const children = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe" })
    .stdout.toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
  return children.flatMap((child) => [child, ...descendants(child)]);
}

export function commandOf(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

export function descendantRunning(ancestor: number, command: string): number {
  const found = descendants(ancestor).find((pid) => commandOf(pid).includes(command));
  if (found === undefined) throw new Error(`no process under ${ancestor} runs \`${command}\``);
  return found;
}

export function alive(pid: number): boolean {
  return Bun.spawnSync(["kill", "-0", String(pid)], { stderr: "ignore" }).exitCode === 0;
}

export function killPid(pid: number): void {
  Bun.spawnSync(["kill", "-9", String(pid)]);
}

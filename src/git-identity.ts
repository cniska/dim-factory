export function committerName(): string | null {
  const proc = Bun.spawnSync(["git", "config", "--global", "--get", "user.name"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) return null;
  return new TextDecoder().decode(proc.stdout).trim() || null;
}

/**
 * Who this machine commits as. The corpus indexes every repo the owner has a
 * session in, upstream history included, so most of the authors in it are other
 * people — and a subject written by someone else in a repo that was only cloned
 * is not this person's distillation of their own work. Asking git is what keeps
 * that filter from being a name written down here.
 */
export function committerName(): string | null {
  const proc = Bun.spawnSync(["git", "config", "--global", "--get", "user.name"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) return null;
  return new TextDecoder().decode(proc.stdout).trim() || null;
}

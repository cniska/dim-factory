/**
 * Whether a process is still there, asked rather than kept: signal 0 tests for a
 * process without touching it, and a process owned by another user answers EPERM,
 * which is an answer that it exists.
 *
 * This is what stands in for a heartbeat. Nothing has to keep writing to say it is
 * alive, and a run killed mid-write leaves a pid that simply stops answering.
 */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

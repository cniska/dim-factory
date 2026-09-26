export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

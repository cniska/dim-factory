/**
 * Every diagnostic dim writes to stderr, as bytes. Bun's console.error paints
 * stderr red and obeys FORCE_COLOR even when stderr is a pipe, so a message sent
 * through it reaches a caller that parses it, such as `scripts/wt.test.sh`,
 * wrapped in escapes it never asked for.
 */
export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

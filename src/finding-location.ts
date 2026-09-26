/** Where a review finding points, as `file:line`, or as much of that as the finding recorded. */
export function findingLocation(finding: { file: string | null; line: number | null }): string | null {
  if (finding.file === null) return null;
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

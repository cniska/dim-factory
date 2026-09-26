export function findingLocation(finding: { file: string | null; line: number | null }): string | null {
  if (finding.file === null) return null;
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

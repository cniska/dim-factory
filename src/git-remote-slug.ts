export const SLUG_SED = [
  "y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/",
  "s#^[a-z][a-z0-9+.-]*://([^/@]*@)?([^/:]*)(:[0-9]+)?#\\2#",
  "s#^[^/@]*@##",
  "s#^([^/:]+):/*#\\1/#",
  "s#/+$##",
  "s#^(.+)/[^/]+$#\\1#p",
].join("\n");

export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function remoteSlug(url: string): string | null {
  const slug = foldAscii(url)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/([^/@]*@)?([^/:]*)(:[0-9]+)?/, "$2")
    .replace(/^[^/@]*@/, "")
    .replace(/^([^/:]+):\/*/, "$1/")
    .replace(/\/+$/, "");
  const cut = slug.lastIndexOf("/");
  return cut > 0 ? slug.slice(0, cut) : null;
}
export function isHostQualified(owner: string): boolean {
  return (
    owner.includes("/") && [...owner].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}

export function ownerDeclaration(owners: string[]): string {
  return `# dim-owners: ${JSON.stringify(owners.map(foldAscii))}`;
}

export function ownerCasePatterns(owners: string[]): string {
  return owners.map((owner) => `'${foldAscii(owner).replaceAll("'", "'\\''")}'`).join("|") || "''";
}

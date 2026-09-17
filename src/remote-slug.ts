/**
 * A remote's trust identity: everything its URL names before the repository
 * itself, with the scheme, any userinfo and any port removed and an scp-style
 * colon read as a separator.
 *
 * Deliberately not `repositoryLabel`, which drops the host so a repository
 * keeps its name when it moves between forges. Here the host is the whole
 * point: an account name is not an identity, because anyone may register
 * `<name>` on another forge or call a directory that, and the gate this feeds
 * runs the repository's own declared check.
 *
 * The sed below is the copy that runs, inside the hook scripts, where there is
 * no database and no `dim` on PATH yet. This function exists to suggest owners
 * and to be tested against that sed, and the test asserts they agree.
 */
export const SLUG_SED = [
  "s#^[a-zA-Z][a-zA-Z0-9+.-]*://##",
  "s#^[^/@]*@##",
  "s#^([^/:]+):([0-9]+)/#\\1/#",
  "s#^([^/:]+):#\\1/#",
  "s#/+$##",
  "s#^(.+)/[^/]+$#\\1#p",
].join("\n");

export function remoteSlug(url: string): string | null {
  const slug = url
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "")
    .replace(/^([^/:]+):([0-9]+)\//, "$1/")
    .replace(/^([^/:]+):/, "$1/")
    .replace(/\/+$/, "");
  const cut = slug.lastIndexOf("/");
  return cut > 0 ? slug.slice(0, cut) : null;
}

/**
 * Whether an owner names a host as well as an account. A bare `cniska` matched
 * any forge and any directory that happened to end in it, so the gate armed on
 * repositories the owner had only cloned; an owner list from before that is
 * refused rather than quietly matching nothing.
 */
export function isHostQualified(owner: string): boolean {
  return owner.includes("/");
}

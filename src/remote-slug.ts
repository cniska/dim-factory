/**
 * A remote's trust identity: everything its URL names before the repository
 * itself, with the scheme, any userinfo and any port removed, an scp-style
 * colon read as a separator, and ASCII letters folded to lower case.
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
  "y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/",
  "s#^[a-z][a-z0-9+.-]*://([^/@]*@)?([^/:]*)(:[0-9]+)?#\\2#",
  "s#^[^/@]*@##",
  "s#^([^/:]+):/*#\\1/#",
  "s#/+$##",
  "s#^(.+)/[^/]+$#\\1#p",
].join("\n");

/**
 * The case folding the sed's `y` performs: A-Z and nothing else. A
 * `toLowerCase` folds more than that, and the two would then disagree on a host
 * holding one non-ASCII letter. An owner list is folded with it as well, so the
 * list and the slug it is matched against cannot differ by case alone.
 */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function remoteSlug(url: string): string | null {
  const slug = foldAscii(url)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/([^/@]*@)?([^/:]*)(:[0-9]+)?/, "$2")
    .replace(/^[^/@]*@/, "")
    // A port only follows a host a scheme introduced. Without one the colon is
    // scp syntax for a path separator, and an account may be all digits.
    .replace(/^([^/:]+):\/*/, "$1/")
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

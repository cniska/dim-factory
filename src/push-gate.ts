import { foldAscii, SLUG_SED } from "./remote-slug";

/**
 * A git rule the record says is stated and not held: the corpus holds 72 force
 * pushes, and separately the skill forbidding them was loaded in 114 of the 333
 * sessions that committed (`docs/findings.md`). What a hook can read is the
 * shape rather than the flag — a push whose remote tip is not an ancestor of
 * what is being pushed rewrites history that is already out, whether it got
 * there by `--force`, `--force-with-lease` or a refspec.
 *
 * Only the branch the remote's own HEAD names is protected. A topic branch is
 * rewritten on purpose all day, and `--no-verify` is the way past this one
 * without taking any other gate with it.
 */
/**
 * Checkouts carrying the gate that it can never fire in. The hook learns which
 * branch is shared from `refs/remotes/origin/HEAD`, which `git clone` writes and
 * nothing else does, so a repo the owner started with `git init` and a
 * `remote add` is gated by a hook that exits before it reads anything.
 *
 * A repo with no remote is not reported: the whole gate is off there by design,
 * because ownership is what decides whether these rules apply at all.
 */
export function unarmedCheckouts(dirs: string[]): string[] {
  return dirs.filter((dir) => {
    const has = (args: string[]) =>
      Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" }).success;
    return (
      has(["config", "--get", "remote.origin.url"]) &&
      !has(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
    );
  });
}

/**
 * One spelling for a remote URL, as bash. The hook compares the URL git hands it
 * against the URLs the checkout has configured, and the same remote is written
 * many ways. Exported so a test can run it on its own: for a path that is a
 * directory the cd normalizes on its own, so the other branches are reachable
 * only here.
 *
 * Logical pwd rather than `pwd -P`, because resolving symlinks would rewrite the
 * very path an owner list was written against.
 */
export const URL_NORMALIZER = `dim_url() {
  u=\${1#file://}
  u=\${u%/}
  if [ -d "$u" ]; then (cd "$u" 2>/dev/null && pwd) || printf '%s' "$u"; else printf '%s' "$u"; fi
}`;

export function prePushScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

remote="\${1:-}"
${URL_NORMALIZER}

# Git names the remote being pushed to and its URL. Reading the owner off that
# URL rather than off origin is what makes a push to a fork's upstream, or to a
# second remote, judged against the account it is actually integrating into.
url=$(dim_url "\${2:-}")
owner=$(printf '%s' "$url" | sed -nE '${SLUG_SED}')
[ -n "$owner" ] || exit 0
case " ${owners.map(foldAscii).join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

# Git names the remote by its name when the push named one and by its URL when it
# did not, and only a name has a refs/remotes/<name>/HEAD to read the shared
# branch from.
if ! git config --get "remote.$remote.url" >/dev/null 2>&1; then
  # get-url --push resolves insteadOf and a separate pushurl, neither of which
  # reading remote.<name>.url out of the config would see.
  match=""
  for name in $(git remote 2>/dev/null); do
    [ "$(dim_url "$(git remote get-url --push "$name" 2>/dev/null)")" = "$url" ] || continue
    match=$name
    # Several remotes may share a URL and only one of them name a shared branch.
    git symbolic-ref -q "refs/remotes/$name/HEAD" >/dev/null 2>&1 && break
  done
  remote=$match
  [ -n "$remote" ] || exit 0
fi

head=$(git symbolic-ref --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)
[ -n "$head" ] || exit 0
protected="refs/heads/\${head#"$remote"/}"

status=0
while read -r _local_ref local_oid remote_ref remote_oid; do
  # A revert is judged on every branch, not only the shared one: git's sequencer
  # commits one without running commit-msg, so this is the first gate that sees it.
  if [ -n "\${local_oid//0/}" ]; then
    if [ -n "\${remote_oid//0/}" ] && git cat-file -e "$remote_oid" 2>/dev/null; then
      span="$remote_oid..$local_oid"
    else
      span="$local_oid --not --remotes=$remote"
    fi
    reverts=$(git log --no-merges --format='  %h %s' --grep='^Revert "' $span 2>/dev/null || true)
    if [ -n "$reverts" ]; then
      echo "pre-push: this pushes a revert." >&2
      echo "$reverts" >&2
      echo "  drop the commit instead: reset or rebase it out." >&2
      status=1
    fi
  fi

  [ "$remote_ref" = "$protected" ] || continue

  # An all-zero oid is git's way of saying the ref is absent on one side.
  if [ -z "\${local_oid//0/}" ]; then
    echo "pre-push: this deletes $protected on $remote." >&2
    status=1
    continue
  fi
  [ -n "\${remote_oid//0/}" ] || continue

  # The tip is missing locally exactly when it is a commit this checkout has
  # never fetched, which is the push that loses work rather than the one that
  # cannot be judged.
  if ! git cat-file -e "$remote_oid" 2>/dev/null; then
    echo "pre-push: $protected on $remote is at $remote_oid, which is not in this checkout." >&2
    echo "  fetch before deciding what to do with it." >&2
    status=1
    continue
  fi

  git merge-base --is-ancestor "$remote_oid" "$local_oid" 2>/dev/null && continue
  echo "pre-push: this rewrites $protected on $remote." >&2
  echo "  its tip $remote_oid is not in the history being pushed." >&2
  status=1
done

[ "$status" -eq 0 ] || echo "  rebase onto it, push a branch, or --no-verify to push anyway." >&2
exit $status
`;
}

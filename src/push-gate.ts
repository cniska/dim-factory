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
export function prePushScript(owners: string[]): string {
  return `#!/usr/bin/env bash
# Installed by \`dim install-commit-gate\`. One copy for every repo; see dim-factory.
set -u

remote="\${1:-}"
# Git names the remote being pushed to and its URL. Reading the owner off that
# URL rather than off origin is what makes a push to a fork's upstream, or to a
# second remote, judged against the account it is actually landing in.
owner=$(printf '%s' "\${2:-}" | sed -n 's#.*[:/]\\([^/]*\\)/[^/]*$#\\1#p')
case " ${owners.join(" ")} " in
  *" $owner "*) ;;
  *) exit 0 ;;
esac

head=$(git symbolic-ref --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)
[ -n "$head" ] || exit 0
protected="refs/heads/\${head#"$remote"/}"

status=0
while read -r _local_ref local_oid remote_ref remote_oid; do
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

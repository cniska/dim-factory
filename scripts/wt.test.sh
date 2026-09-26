#!/usr/bin/env bash
set -u

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

WT="${WT_CMD:-dim wt}"

pass=0; fail=0
assert(){
  if [ "$2" = "$3" ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL %s\n  want: [%s]\n  got:  [%s]\n' "$1" "$3" "$2"; fi
}
contains(){
  case "$2" in *"$3"*) pass=$((pass+1)) ;;
    *) fail=$((fail+1)); printf 'FAIL %s\n  expected to contain: [%s]\n  in: [%s]\n' "$1" "$3" "$2" ;; esac
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wt-test.XXXXXX")" || exit 1
TMP="$(cd "$TMP" && pwd -P)" || exit 1
REPO="$TMP/repo"
trap 'rm -rf "$TMP"' EXIT

git init -q -b main "$REPO"
( cd "$REPO"
  git config user.email test@example.com
  git config user.name test
  printf initial > README.md
  git add README.md
  git commit -qm initial )

run(){ ( cd "$REPO" && $WT "$@" ); }

write_hook(){
  mkdir -p "$REPO/scripts"
  printf '%s\n' '#!/usr/bin/env bash' "$2" > "$REPO/scripts/$1"
  chmod +x "$REPO/scripts/$1"
  ( cd "$REPO" && git add "scripts/$1" && git commit -qm "$1" )
}

assert "path prints the conventional location" \
  "$(run path task-a)" "$REPO/.claude/worktrees/task-a"
assert "ls reports no task worktrees before creation" "$(run ls)" "wt: no task worktrees"

write_hook worktree-setup.sh 'printf ready > .wt-bootstrap-ran'
opened=$(run task-a)
contains "open reports bootstrap" "$opened" "wt: bootstrapping worktree via scripts/worktree-setup.sh"
contains "open prints the worktree path" "$opened" "$REPO/.claude/worktrees/task-a"
assert "open creates the worktree" "$([ -d "$REPO/.claude/worktrees/task-a" ] && echo yes || echo no)" yes
assert "open runs the bootstrap hook only on creation" "$(cat "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran")" ready
assert "open creates the requested branch" "$(git -C "$REPO" branch --show-current; git -C "$REPO/.claude/worktrees/task-a" branch --show-current | tail -1)" $'main\ntask-a'

rm "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran"
reused=$(run task-a)
contains "existing worktree is reused" "$reused" "wt: reusing existing worktree"
assert "reuse skips bootstrap" "$([ -e "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran" ] && echo yes || echo no)" no

contains "ls includes the managed branch" "$(run ls)" "task-a"
contains "ls includes the managed path" "$(run ls)" "$REPO/.claude/worktrees/task-a"
removed=$(run rm task-a)
contains "rm reports removal" "$removed" "wt: removed worktree $REPO/.claude/worktrees/task-a"
assert "rm removes the worktree" "$([ -d "$REPO/.claude/worktrees/task-a" ] && echo yes || echo no)" no
assert "rm keeps the branch" "$(git -C "$REPO" show-ref --verify --quiet refs/heads/task-a; echo $?)" 0

write_hook worktree-setup.sh 'exit 0'
write_hook worktree-teardown.sh "printf ran > $TMP/teardown-ran"
run task-b > /dev/null
torn=$(run rm task-b)
contains "rm reports teardown" "$torn" "wt: tearing down worktree via scripts/worktree-teardown.sh"
assert "teardown runs before removal" "$(cat "$TMP/teardown-ran")" ran
assert "a clean teardown removes the worktree" "$([ -d "$REPO/.claude/worktrees/task-b" ] && echo yes || echo no)" no

write_hook worktree-teardown.sh 'exit 3'
run task-c > /dev/null
set +e
refused=$(run rm task-c 2>&1); refused_rc=$?
set -e
assert "a failed teardown exits non-zero" "$refused_rc" 1
contains "a failed teardown says the worktree is kept" "$refused" "teardown failed (exit 3) — worktree kept"
assert "a failed teardown keeps the worktree" "$([ -d "$REPO/.claude/worktrees/task-c" ] && echo yes || echo no)" yes
forced=$(run rm --force task-c 2>&1)
contains "--force removes past a failed teardown" "$forced" "wt: removed worktree $REPO/.claude/worktrees/task-c"
assert "--force removes the worktree" "$([ -d "$REPO/.claude/worktrees/task-c" ] && echo yes || echo no)" no

write_hook worktree-teardown.sh 'kill -9 $$'
run task-d > /dev/null
set +e
signalled=$(run rm task-d 2>&1); signalled_rc=$?
set -e
assert "a signal-killed teardown exits non-zero" "$signalled_rc" 1
contains "a signal-killed teardown says the worktree is kept" "$signalled" "worktree kept"
assert "a signal-killed teardown keeps the worktree" "$([ -d "$REPO/.claude/worktrees/task-d" ] && echo yes || echo no)" yes
run rm --force task-d > /dev/null 2>&1

commit_worker_hook(){
  local tree="$REPO/.claude/worktrees/$1"
  mkdir -p "$tree/scripts"
  printf '%s\n' '#!/usr/bin/env bash' "$2" > "$tree/scripts/worktree-teardown.sh"
  chmod +x "$tree/scripts/worktree-teardown.sh"
  ( cd "$tree" && git add scripts/worktree-teardown.sh && git commit -qm worker-hook )
}
write_hook worktree-teardown.sh "pwd -P > $TMP/trunk-teardown-cwd"
run task-f > /dev/null
commit_worker_hook task-f "printf ran > $TMP/worker-teardown-ran"
trunk_torn=$(run rm task-f 2>&1)
assert "teardown runs the trunk's hook inside the worktree" \
  "$(cat "$TMP/trunk-teardown-cwd" 2>/dev/null)" "$REPO/.claude/worktrees/task-f"
assert "teardown ignores the worktree's hook" "$([ -e "$TMP/worker-teardown-ran" ] && echo yes || echo no)" no
contains "the teardown report names the trunk's hook" "$trunk_torn" "\"argv\":[\"$REPO/scripts/worktree-teardown.sh\"]"

rm -f "$TMP/worker-teardown-ran"
( cd "$REPO" && git rm -q scripts/worktree-teardown.sh && git commit -qm "no teardown" )
run task-g > /dev/null
commit_worker_hook task-g "printf ran > $TMP/worker-teardown-ran"
untorn=$(run rm task-g 2>&1)
assert "a worktree's hook does not run when the trunk has none" \
  "$([ -e "$TMP/worker-teardown-ran" ] && echo yes || echo no)" no
assert "no trunk hook means no teardown" "$(grep -c "tearing down" <<< "$untorn")" 0
write_hook worktree-teardown.sh 'exit 0'

mkdir -p "$REPO/.claude/worktrees"
printf notadir > "$REPO/.claude/worktrees/task-e"
set +e
notdir=$(run task-e 2>&1); notdir_rc=$?
set -e
assert "a file where the worktree goes exits non-zero" "$notdir_rc" 1
assert "a file where the worktree goes creates no worktree" \
  "$([ -d "$REPO/.claude/worktrees/task-e" ] && echo yes || echo no)" no
rm "$REPO/.claude/worktrees/task-e"

contains "prune reports what it did" "$(run prune)" "wt: pruned stale worktree entries"
contains "no arguments prints usage" "$(run)" "parallel-task worktrees, one per agent"
contains "--help prints usage" "$(run --help)" "dim wt path <branch>"

set +e
twice=$(run rm task-a task-b 2>&1); twice_rc=$?
bogus=$(run rm --bogus task-a 2>&1); bogus_rc=$?
absent=$(run rm no-such-branch 2>&1); absent_rc=$?
set -e
assert "two branch names is an error" "$twice" "wt: branch name specified more than once"
assert "two branch names exits non-zero" "$twice_rc" 1
assert "an unknown rm option is named" "$bogus" "wt: unknown rm option: --bogus"
assert "removing an absent worktree exits non-zero" "$absent_rc" 1
contains "removing an absent worktree says where it looked" "$absent" "wt: no worktree at"

set +e
forced=$(cd "$REPO" && FORCE_COLOR=3 $WT rm task-a task-b 2>&1)
set -e
assert "an error carries no escapes when the environment forces color" \
  "$forced" "wt: branch name specified more than once"

set +e
missing=$(run path 2>&1); missing_rc=$?
outside=$(cd "$TMP" && $WT ls 2>&1); outside_rc=$?
set -e
assert "path without a branch exits non-zero" "$missing_rc" 1
assert "path without a branch explains the problem" "$missing" "wt: branch name required"
assert "outside a repo exits non-zero" "$outside_rc" 1
assert "outside a repo explains the problem" "$outside" "wt: not inside a git repository"

total=$((pass + fail))
printf '\n%d/%d passed' "$pass" "$total"
[ "$fail" -eq 0 ] && { printf ' — all green\n'; exit 0; } || { printf ' — %d FAILED\n' "$fail"; exit 1; }

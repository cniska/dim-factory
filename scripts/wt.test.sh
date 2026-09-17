#!/usr/bin/env bash
# Behavior tests for wt. Pure bash plus git; every case uses a throwaway repo.
# Run: /usr/local/bin/wt.test.sh   (exit 0 = all pass, 1 = failures)
set -u

# The command under test, word-split so it can carry arguments. These cases pin
# the messages and exit codes `dim wt` prints, so they are run against it rather
# than against a copy of the logic.
WT="${WT_CMD:-dim wt}"

pass=0; fail=0
assert(){ # desc, got, want
  if [ "$2" = "$3" ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL %s\n  want: [%s]\n  got:  [%s]\n' "$1" "$3" "$2"; fi
}
contains(){ # desc, haystack, needle
  case "$2" in *"$3"*) pass=$((pass+1)) ;;
    *) fail=$((fail+1)); printf 'FAIL %s\n  expected to contain: [%s]\n  in: [%s]\n' "$1" "$3" "$2" ;; esac
}

TMP="$(cd "$(mktemp -d)" && pwd -P)"; REPO="$TMP/repo"
trap 'rm -rf "$TMP"' EXIT

git init -q -b main "$REPO"
( cd "$REPO"
  git config user.email test@example.com
  git config user.name test
  printf initial > README.md
  git add README.md
  git commit -qm initial )

run(){ ( cd "$REPO" && $WT "$@" ); }

# Commit a hook so worktrees created after this point check it out.
write_hook(){ # name, body
  mkdir -p "$REPO/scripts"
  printf '%s\n' '#!/usr/bin/env bash' "$2" > "$REPO/scripts/$1"
  chmod +x "$REPO/scripts/$1"
  ( cd "$REPO" && git add "scripts/$1" && git commit -qm "$1" )
}

# path and ls: no worktree yet
assert "path prints the conventional location" \
  "$(run path task-a)" "$REPO/.claude/worktrees/task-a"
assert "ls reports no task worktrees before creation" "$(run ls)" "wt: no task worktrees"

# open: creates a branch/worktree, runs the optional hook, and reports the path.
write_hook worktree-setup.sh 'printf ready > .wt-bootstrap-ran'
opened=$(run task-a)
contains "open reports bootstrap" "$opened" "wt: bootstrapping worktree via scripts/worktree-setup.sh"
contains "open prints the worktree path" "$opened" "$REPO/.claude/worktrees/task-a"
assert "open creates the worktree" "$([ -d "$REPO/.claude/worktrees/task-a" ] && echo yes || echo no)" yes
assert "open runs the bootstrap hook only on creation" "$(cat "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran")" ready
assert "open creates the requested branch" "$(git -C "$REPO" branch --show-current; git -C "$REPO/.claude/worktrees/task-a" branch --show-current | tail -1)" $'main\ntask-a'

# reuse: must preserve the worktree and skip bootstrap.
rm "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran"
reused=$(run task-a)
contains "existing worktree is reused" "$reused" "wt: reusing existing worktree"
assert "reuse skips bootstrap" "$([ -e "$REPO/.claude/worktrees/task-a/.wt-bootstrap-ran" ] && echo yes || echo no)" no

# ls and rm: only managed worktrees appear, rm keeps the branch for post-merge cleanup.
contains "ls includes the managed branch" "$(run ls)" "task-a"
contains "ls includes the managed path" "$(run ls)" "$REPO/.claude/worktrees/task-a"
removed=$(run rm task-a)
contains "rm reports removal" "$removed" "wt: removed worktree $REPO/.claude/worktrees/task-a"
assert "rm removes the worktree" "$([ -d "$REPO/.claude/worktrees/task-a" ] && echo yes || echo no)" no
assert "rm keeps the branch" "$(git -C "$REPO" show-ref --verify --quiet refs/heads/task-a; echo $?)" 0

# teardown: rm runs the hook while the worktree still exists. The bootstrap hook
# goes quiet first — git refuses to remove a worktree holding untracked files.
write_hook worktree-setup.sh 'exit 0'
write_hook worktree-teardown.sh "printf ran > $TMP/teardown-ran"
run task-b > /dev/null
torn=$(run rm task-b)
contains "rm reports teardown" "$torn" "wt: tearing down worktree via scripts/worktree-teardown.sh"
assert "teardown runs before removal" "$(cat "$TMP/teardown-ran")" ran
assert "a clean teardown removes the worktree" "$([ -d "$REPO/.claude/worktrees/task-b" ] && echo yes || echo no)" no

# a failing teardown keeps the worktree, so nothing outside it is stranded unnamed.
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

# a teardown killed by a signal reports no exit code, and reading that as success
# removes the worktree the hook's resources are named by.
write_hook worktree-teardown.sh 'kill -9 $$'
run task-d > /dev/null
set +e
signalled=$(run rm task-d 2>&1); signalled_rc=$?
set -e
assert "a signal-killed teardown exits non-zero" "$signalled_rc" 1
contains "a signal-killed teardown says the worktree is kept" "$signalled" "worktree kept"
assert "a signal-killed teardown keeps the worktree" "$([ -d "$REPO/.claude/worktrees/task-d" ] && echo yes || echo no)" yes
run rm --force task-d > /dev/null 2>&1
write_hook worktree-teardown.sh 'exit 0'

# a plain file where a worktree would go is not a worktree: reporting one ready
# sends the caller to a path holding nothing.
mkdir -p "$REPO/.claude/worktrees"
printf notadir > "$REPO/.claude/worktrees/task-e"
set +e
notdir=$(run task-e 2>&1); notdir_rc=$?
set -e
assert "a file where the worktree goes exits non-zero" "$notdir_rc" 1
assert "a file where the worktree goes creates no worktree" \
  "$([ -d "$REPO/.claude/worktrees/task-e" ] && echo yes || echo no)" no
rm "$REPO/.claude/worktrees/task-e"

# prune and usage: the paths with no case at all before.
contains "prune reports what it did" "$(run prune)" "wt: pruned stale worktree entries"
contains "no arguments prints usage" "$(run)" "parallel-task worktrees, one per agent"
contains "--help prints usage" "$(run --help)" "dim wt path <branch>"

# rm argument parsing.
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

# errors: missing arguments and calls outside a repository stay actionable.
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

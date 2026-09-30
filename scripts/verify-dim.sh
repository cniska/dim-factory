#!/bin/bash
set -euo pipefail

usage="usage: scripts/verify-dim.sh new | scripts/verify-dim.sh <run-dir> <dim args...>"
checkout=$(cd "$(dirname "$0")/.." && pwd)
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }

enter() {
  scratch="$1"
  repo="$scratch/repo"
  export DIM_HOME="$scratch/dim"
  export DIM_CLAUDE_PROJECTS="$scratch/claude/projects"
  export DIM_CODEX_DIR="$scratch/codex"
  export GROK_HOME="$scratch/grok"
  export PATH="$scratch/bin:$PATH"
}

if [ "$1" = new ]; then
  enter "$(mktemp -d "${TMPDIR:-/tmp}/dim-verify-XXXXXX")"
  mkdir -p "$scratch/bin" "$DIM_HOME"
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$checkout/src/cli.ts" > "$scratch/bin/dim"
  chmod +x "$scratch/bin/dim"
  dim install-hooks --write > /dev/null

  git init -q -b main "$repo"
  git -C "$repo" config user.name Verify
  git -C "$repo" config user.email verify@example.com
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" remote add origin https://github.com/example/verify.git
  printf '{"scripts":{"verify":"true"}}\n' > "$repo/package.json"
  : > "$repo/bun.lock"
  printf '.claude/\n' > "$repo/.gitignore"
  git -C "$repo" add .
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
    git -C "$repo" commit -q -m "chore: start"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  dim sync > /dev/null
  echo "$scratch"
  exit 0
fi

[ -d "$1/dim" ] || { echo "verify-dim: $1 holds no verify run" >&2; exit 1; }
enter "$1"
shift
spool_hook=$(bun -e '
const config = await Bun.file(process.argv[1]).json();
const hook = config.hooks.SessionStart.flatMap((entry) => entry.hooks).find((h) => h.command.startsWith("cat >"));
console.log(hook.command);
' "$scratch/claude/settings.json")
printf '{"session_id":"verify-session-%s","hook_event_name":"SessionStart","source":"startup","cwd":"%s"}' \
  "$(date +%s%N)" "$repo" | sh -c "$spool_hook"
cd "$repo"
dim "$@"

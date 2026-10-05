#!/bin/bash
set -euo pipefail

usage="usage: scripts/verify-dim.sh new | scripts/verify-dim.sh <run-dir> <dim args...>"
checkout=$(cd "$(dirname "$0")/.." && pwd)
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }

enter() {
  scratch="$1"
  repo="$scratch/repo"
  export HOME="$scratch/home"
  export XDG_CONFIG_HOME="$scratch/config"
  export XDG_DATA_HOME="$scratch/data"
  export XDG_STATE_HOME="$scratch/state"
  export PATH="$scratch/bin:$PATH"
}

if [ "$1" = new ]; then
  enter "$(mktemp -d "${TMPDIR:-/tmp}/dim-verify-XXXXXX")"
  mkdir -p "$scratch/bin" "$HOME"
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$checkout/src/cli.ts" > "$scratch/bin/dim"
  chmod +x "$scratch/bin/dim"
  dim hooks install > /dev/null

  git init -q -b main "$repo"
  git -C "$repo" config user.name Verify
  git -C "$repo" config user.email verify@example.com
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" remote add origin https://github.com/example/verify.git
  mkdir -p "$repo/noop"
  printf '{"name":"noop","version":"1.0.0"}\n' > "$repo/noop/package.json"
  printf '{"name":"verify","scripts":{"verify":"true"},"dependencies":{"noop":"file:./noop"}}\n' > "$repo/package.json"
  (cd "$repo" && bun install --silent)
  printf '.claude/\nnode_modules/\n' > "$repo/.gitignore"
  git -C "$repo" add .
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
    git -C "$repo" commit -q -m "chore: start"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  dim sync > /dev/null
  echo "$scratch"
  exit 0
fi

[ -d "$1/home" ] || { echo "verify-dim: $1 holds no verify run" >&2; exit 1; }
enter "$1"
shift
spool_hook=$(bun -e '
const config = await Bun.file(process.argv[1]).json();
const hook = config.hooks.SessionStart.flatMap((entry) => entry.hooks).find((h) => h.command.startsWith("cat >"));
console.log(hook.command);
' "$HOME/.claude/settings.json")
printf '{"session_id":"verify-session-%s","hook_event_name":"SessionStart","source":"startup","cwd":"%s"}' \
  "$(date +%s%N)" "$repo" | sh -c "$spool_hook"
cd "$repo"
dim "$@"

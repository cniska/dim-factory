#!/bin/bash
set -euo pipefail

checkout=$(cd "$(dirname "$0")/.." && pwd)
scratch="${1:-}"
fresh=false
if [ -z "$scratch" ]; then
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/dim-verify-XXXXXX")
  fresh=true
fi
[ -d "$scratch/dim" ] || [ "$fresh" = true ] || { echo "verify-home: $scratch holds no verify home" >&2; exit 1; }
repo="$scratch/repo"

export DIM_HOME="$scratch/dim"
export DIM_CLAUDE_PROJECTS="$scratch/claude/projects"
export DIM_CODEX_DIR="$scratch/codex"
export GROK_HOME="$scratch/grok"
export PATH="$scratch/bin:$PATH"

if [ "$fresh" = true ]; then
  mkdir -p "$scratch/bin" "$DIM_HOME"
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$checkout/src/cli.ts" > "$scratch/bin/dim"
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$checkout/scripts/verify-harness.ts" > "$scratch/bin/codex"
  chmod +x "$scratch/bin/dim" "$scratch/bin/codex"
  printf '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }\n' > "$DIM_HOME/routing.json"
  dim install-hooks --write > /dev/null

  git init -q -b main "$repo"
  git -C "$repo" config user.name Verify
  git -C "$repo" config user.email verify@example.com
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config dim.ship trunk
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
fi

spool_hook=$(bun -e '
const config = await Bun.file(process.argv[1]).json();
const hook = config.hooks.SessionStart.flatMap((entry) => entry.hooks).find((h) => h.command.startsWith("cat >"));
console.log(hook.command);
' "$scratch/claude/settings.json")
session="verify-operator-$(date +%s%N)"
payload=$(printf '{"session_id":"%s","hook_event_name":"SessionStart","source":"startup","cwd":"%s"}' "$session" "$repo")

cat <<EOF
export DIM_VERIFY_DIR=$(printf %q "$scratch")
export DIM_VERIFY_REPO=$(printf %q "$repo")
export DIM_HOME=$(printf %q "$DIM_HOME")
export DIM_CLAUDE_PROJECTS=$(printf %q "$DIM_CLAUDE_PROJECTS")
export DIM_CODEX_DIR=$(printf %q "$DIM_CODEX_DIR")
export GROK_HOME=$(printf %q "$GROK_HOME")
export PATH=$(printf %q "$PATH")
printf '%s' $(printf %q "$payload") | sh -c $(printf %q "$spool_hook")
(cd "\$DIM_VERIFY_REPO" && dim operator >&2)
EOF

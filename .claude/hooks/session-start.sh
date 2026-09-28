#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

pinned=$(sed -n 's/^bun = "\(.*\)"$/\1/p' mise.toml)
if [ "$(bun --version 2>/dev/null || true)" != "$pinned" ]; then
  npm install -g "bun@$pinned"
fi

if ! command -v ssh-keygen >/dev/null; then
  apt-get install -y openssh-client || { apt-get update && apt-get install -y openssh-client; }
fi

bun install

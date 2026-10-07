#!/bin/sh
set -eu
cd "$WORKSPACE"
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p src
printf '{"name":"greet","type":"module","bin":{"greet":"./src/cli.ts"}}\n' > package.json
printf 'const [name] = process.argv.slice(2);\nconsole.log(`Hello, ${name ?? "world"}`);\n' > src/cli.ts
printf '# greet\n\nPrints a greeting: `greet [name]`.\n' > README.md
git add -A
git commit -qm "chore: start"

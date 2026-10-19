#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
if /usr/sbin/lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 'Port 4317 is already in use. No additional service started.'
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)'
print 'Harbor: http://127.0.0.1:4317/ — keep this terminal open'
exec node --env-file-if-exists=.env --import tsx server/index.ts

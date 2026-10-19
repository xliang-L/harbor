#!/bin/zsh
set -e
cd "$(dirname "$0")"
echo "当前电脑：$(hostname)"
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("需要 Node.js 22 或更新版本");process.exit(1)}'
npm ci
npm run lint
npm run typecheck
npm test
npm run build
echo '准备完成。双击 启动Harbor.command 打开本地服务。'
